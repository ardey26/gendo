import { useEffect, useState } from "react";
import { allowanceHistory, readVault, type Get, type PaymentView, type ReadNetwork, type VaultView } from "../../../sdk/src/read/index.ts";
import { Chain, Mark, Netband, Spinner } from "../ui/Brand.tsx";
import { ada, allowanceSentence, cleanPurpose, fromNow, paymentLine, periodName } from "./format.ts";

const get: Get = async (path) => {
  let r: Response;
  try {
    r = await fetch(`/chain${path}`);
  } catch {
    throw new Error("The chain is unavailable right now. Try again in a minute.");
  }
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error("The chain is unavailable right now. Try again in a minute.");
  return r.json();
};
const short = (s: string) => (s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s);
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

type Ready = { phase: "ready"; vault: VaultView; name?: string; listed: boolean; labels: Record<string, string>; history: (PaymentView & { unit: string })[]; tipMs: number };
type State = { phase: "loading" } | { phase: "error"; message: string } | { phase: "missing" } | Ready;

export function PublicPage({ policy, network }: { policy: string; network: ReadNetwork }) {
  const [s, setS] = useState<State>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    (async () => {
      const tip = (await get("/blocks/latest")) as { time: number } | undefined;
      const tipMs = tip ? tip.time * 1000 : Date.now();
      const vault = await readVault(get, policy, network, tipMs);
      if (!vault) return setS({ phase: "missing" });
      const listing = await fetch(`/public/${policy}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ name: string; listed: boolean; agents: Record<string, string> }>) : undefined))
        .catch(() => undefined);
      const history = (
        await Promise.all(
          vault.allowances.filter((a) => a.status !== "malformed").map(async (a) => (await allowanceHistory(get, a.unit, vault.address, a.txHash)).map((p) => ({ ...p, unit: a.unit }))),
        )
      ).flat().sort((a, b) => b.time - a.time);
      setS({ phase: "ready", vault, name: listing?.name, listed: listing?.listed === true, labels: listing?.agents ?? {}, history, tipMs });
    })().catch((e) => setS({ phase: "error", message: (e as Error).message }));
  }, [policy, network]);

  useEffect(() => {
    if (s.phase !== "ready" || !s.listed) return;
    const m = document.querySelector('meta[name="robots"]');
    m?.remove();
    return () => void (m && document.head.append(m));
  }, [s]);

  const frame = (body: React.ReactNode, attr: Record<string, string> = {}) => (
    <div className="app" {...attr}>
      <Netband />
      <header className="top" style={{ background: "#0f0d0a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Mark />
          <span style={{ fontWeight: 900, fontSize: 15 }}>gendo</span>
          <span className="faint pub-path">/</span>
          <span className="mono pub-path" style={{ fontSize: 13 }}>w/{short(policy)}</span>
        </div>
        <a className="btn pri" href="/">Connect wallet</a>
      </header>
      {body}
    </div>
  );
  if (s.phase === "loading") return frame(<main className="boot"><Spinner label="Reading the chain…" /></main>);
  if (s.phase === "error") return frame(<main style={{ padding: 20 }}><p>{s.message}</p></main>, { "data-error": "" });
  if (s.phase === "missing") return frame(<main style={{ padding: 20 }}><h1>No vault found</h1><p className="muted">Nothing lives at this vault id on preprod.</p></main>, { "data-ready": "" });

  const { vault, history } = s;
  const cfg = vault.config;
  const week = history.filter((p) => p.time > s.tipMs - 7 * 86_400_000 && (p.kind === "agent" || p.kind === "co-signed"));
  const paidWeek = week.reduce((n, p) => n + p.payees.reduce((m, x) => m + x.lovelace, 0n), 0n);
  const active = vault.allowances.filter((a) => a.status === "active").length;
  const nameOf = (unit: string) => s.labels[unit] ?? `Agent ${short(unit.slice(56))}`;
  const copyId = () => { void navigator.clipboard?.writeText(policy); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return frame(
    <>
      {cfg?.paused && <div className="banner">Paused. No agent can pay until {String(cfg.threshold)} of {cfg.owners.length} owners unpause.</div>}
      <main className="pub">
        <section className="pub-hero">
          <span className="cap">Agent vault on Cardano</span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <h1>{s.name ?? "A gendo vault"}</h1>
            <span className={cfg?.paused ? "pub-status off" : "pub-status"}><i aria-hidden="true" />{cfg ? (cfg.paused ? "Paused" : "Active") : "Config unreadable"}</span>
          </div>
          <p className="muted">
            {active === 0 ? "No agent can spend from it right now." : `${active === 1 ? "One agent can" : `${active} agents can`} pay from it, only inside the limits below.`} The limits live in the vault's code on chain: no one, gendo included, can stretch them.
          </p>
          <div className="pub-proof">
            <span className="faint">Read from the chain at {when(s.tipMs)}</span>
            <span className="pub-id">
              <span className="faint">Vault id</span>
              <span className="mono">{short(policy)}</span>
              <button type="button" className="btn" style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }} onClick={copyId}>{copied ? "Copied" : "Copy"}</button>
            </span>
            <span className="faint">Address <Chain value={vault.address} network={network} label={short(vault.address)} /></span>
          </div>
        </section>

        <section className="pub-stats" aria-label="Summary">
          <div><span className="cap">Treasury</span><b className="mono">{ada(vault.treasuryLovelace)}<small> ADA</small></b><span className="faint">held by the vault</span></div>
          <div><span className="cap">Agents</span><b className="mono">{active}<small> active</small></b><span className="faint">{vault.allowances.length} in total</span></div>
          <div><span className="cap">Paid, last 7 days</span><b className="mono">{ada(paidWeek)}<small> ADA</small></b><span className="faint">in {week.length} {week.length === 1 ? "payment" : "payments"}</span></div>
          <div>
            <span className="cap">Owners</span>
            <b className="mono">{cfg ? <>{cfg.owners.length}<small> {cfg.owners.length === 1 ? "owner" : "owners"}</small></> : "—"}</b>
            <span className="faint">{cfg ? `${cfg.threshold} of ${cfg.owners.length} must sign` : "unreadable"}</span>
          </div>
        </section>

        <section>
          <div className="pub-h"><h2>Agents</h2><span className="cap">what each one may spend</span></div>
          {vault.allowances.length === 0 ? (
            <div className="pub-empty">No agents yet.</div>
          ) : (
            <div className="pub-agents">
              {vault.allowances.map((a) => {
                const l = a.caps.find((c) => c.unit === "lovelace");
                const pct = l && l.perPeriod > 0n ? Number((l.spentThisPeriod * 100n) / l.perPeriod) : 0;
                const status = a.status === "active" && cfg?.paused ? "paused" : a.status;
                const live = a.status === "active";
                return (
                  <article key={a.unit} className="pub-agent">
                    <header>
                      <span className="pub-tile" aria-hidden="true">{nameOf(a.unit).replace(/^Agent /, "")[0]!.toUpperCase()}</span>
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                        <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(a.unit)}</b>
                        <span className={status === "active" ? "faint" : "pill fill"} style={{ fontSize: 12 }}>{status}</span>
                      </span>
                      {a.expiresAt && <span className="faint" style={{ fontSize: 12, textAlign: "right" }}>Expires<br /><span className="mono">{new Date(a.expiresAt).toISOString().slice(0, 10)}</span></span>}
                    </header>
                    {l && live ? (
                      <div className="pub-budget">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span><b className="mono" style={{ fontSize: 22 }}>{ada(l.spentThisPeriod)}</b><span className="faint mono"> / {ada(l.perPeriod)} ADA</span></span>
                          <span className="faint" style={{ fontSize: 12 }}>spent this {periodName(a.periodMs!)}</span>
                        </div>
                        <div className="bar" role="img" aria-label={`${ada(l.spentThisPeriod)} of ${ada(l.perPeriod)} ADA spent`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                        <span className="faint" style={{ fontSize: 12 }}>{ada(l.leftThisPeriod)} ADA left{a.periodEndsAt ? `, resets ${fromNow(a.periodEndsAt, s.tipMs)}` : ""}</span>
                      </div>
                    ) : null}
                    {l && (
                      <div className="pub-rules">
                        <span>Up to {ada(l.perPayment)} ADA a payment</span>
                        <span>{ada(l.perPeriod)} ADA a {periodName(a.periodMs!)}</span>
                        <span>{a.payees.length} approved {a.payees.length === 1 ? "payee" : "payees"}</span>
                      </div>
                    )}
                    <p className="faint" style={{ margin: 0, fontSize: 13 }}>{allowanceSentence(a)}</p>
                    {a.payees.length > 0 && (
                      <div className="pub-payees">
                        <span className="cap">Can pay</span>
                        {a.payees.map((x) => <Chain key={x} value={x} network={network} label={short(x)} />)}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="pub-h"><h2>Payments</h2><span className="cap">recent, current agents</span></div>
          {history.length === 0 ? (
            <div className="pub-empty">No payments yet.</div>
          ) : (
            <ol className="pub-feed">
              {history.map((p) => {
                const paid = p.payees.reduce((n, x) => n + x.lovelace, 0n);
                const spend = p.kind === "agent" || p.kind === "co-signed";
                const note = p.purpose ? cleanPurpose(p.purpose) : "";
                return (
                  <li key={p.txHash + p.unit} className={spend ? "" : "quiet"}>
                    <span className="pub-tile sm" aria-hidden="true">{spend ? (s.labels[p.unit] ?? "A")[0]!.toUpperCase() : "印"}</span>
                    <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                      <span>{s.labels[p.unit] ? <b>{s.labels[p.unit]}: </b> : ""}{paymentLine(p)}.</span>
                      {note && <span className="pub-note">The agent's note (not verified): {note}</span>}
                      <span className="faint" style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                        <span className="mono">{when(p.time)}</span>
                        {p.payees.map((x, i) => <span key={i}>to <Chain value={x.address} network={network} label={short(x.address)} /></span>)}
                        <span>tx <Chain value={p.txHash} network={network} label={short(p.txHash)} /></span>
                      </span>
                    </div>
                    {spend && <b className="mono pub-amt">−{ada(paid)}<small> ADA</small></b>}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {cfg && (
          <section>
            <div className="pub-h"><h2>Owners</h2><span className="cap">{String(cfg.threshold)} of {cfg.owners.length} sign every change</span></div>
            <div className="pub-owners">
              {cfg.owners.map((o) => (
                <div key={o}><span className="stamp" aria-hidden="true">印</span><span className="mono">key {short(o)}</span></div>
              ))}
            </div>
          </section>
        )}

        <section className="pub-how">
          <div><b>The limits are code</b><span className="faint">Each agent's caps, payees and expiry are checked by the vault's script on every payment. A payment that breaks them can't land.</span></div>
          <div><b>Notes aren't proof</b><span className="faint">What an agent writes about a payment is its own claim. Amounts, payees and fees above come from the chain.</span></div>
          <div><b>Check it yourself</b><span className="faint">Every amount links to a public explorer. This page only reads the chain; it can't move anything.</span></div>
        </section>
      </main>
    </>,
    { "data-ready": "" },
  );
}
