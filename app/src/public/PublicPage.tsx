import { useEffect, useState } from "react";
import { allowanceHistory, readVault, type Get, type PaymentView, type ReadNetwork, type VaultView } from "../../../sdk/src/read/index.ts";
import { Chain, Mark, Netband, Spinner } from "../ui/Brand.tsx";
import { ada, allowanceSentence, cleanPurpose, paymentLine } from "./format.ts";

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
          <span className="faint">/</span>
          <span className="mono" style={{ fontSize: 13 }}>w/{short(policy)}</span>
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
  return frame(
    <>
      {cfg?.paused && <div className="banner">Paused. No agent can pay until {String(cfg.threshold)} of {cfg.owners.length} owners unpause.</div>}
      <main style={{ maxWidth: 1240, margin: "0 auto", padding: 20, display: "flex", flexDirection: "column", gap: 16, boxSizing: "border-box" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: "-0.02em" }}>{s.name ?? "A gendo vault"}</h1>
          <span className={cfg?.paused ? "pill fill" : "pill"}>{cfg ? (cfg.paused ? "Paused" : "Active") : "Config unreadable"}</span>
        </div>
        <section className="panel">
          <div className="kv">
            <div><span className="cap">Owners</span><span>{cfg ? `${cfg.threshold} of ${cfg.owners.length} must sign` : "—"}</span></div>
            <div><span className="cap">Treasury</span><span className="mono">{ada(vault.treasuryLovelace)} ADA</span></div>
            <div><span className="cap">Agents</span><span>{active} active</span></div>
            <div><span className="cap">Paid, last 7 days</span><span className="mono">{ada(paidWeek)} ADA in {week.length} payments</span></div>
            <div>
              <span className="cap">Vault id</span>
              <span className="mono" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {short(policy)}
                <button type="button" className="btn" style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }} onClick={() => { void navigator.clipboard?.writeText(policy); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="ph"><h2>Agents</h2></div>
          {vault.allowances.length === 0 ? (
            <p style={{ padding: "10px 14px", margin: 0 }}>No agents yet.</p>
          ) : (
            <div className="scroll">
              <table className="t cards" style={{ minWidth: 900 }}>
                <thead><tr><th>Agent</th><th>Allowance</th><th>Spent this period</th><th>Resets</th><th>Expires</th></tr></thead>
                <tbody>
                  {vault.allowances.map((a) => {
                    const l = a.caps.find((c) => c.unit === "lovelace");
                    const pct = l && l.perPeriod > 0n ? Number((l.spentThisPeriod * 100n) / l.perPeriod) : 0;
                    const status = a.status === "active" && cfg?.paused ? "paused" : a.status;
                    return (
                      <tr key={a.unit}>
                        <td className="lead" style={{ whiteSpace: "nowrap" }}><div className="mono" style={{ fontWeight: 500 }}>{s.labels[a.unit] ?? short(a.unit.slice(56))}</div><div className="faint" style={{ fontSize: 12 }}>{status}</div></td>
                        <td data-label="Allowance" className="wide" style={{ maxWidth: 420 }}>
                          <div>{allowanceSentence(a)}</div>
                          <div className="mono faint" style={{ fontSize: 12, marginTop: 6, display: "flex", flexWrap: "wrap", gap: 8 }}>{a.payees.map((x) => <Chain key={x} value={x} network={network} label={short(x)} />)}</div>
                        </td>
                        <td data-label="Spent this period" className="wide" style={{ minWidth: 180 }}>
                          {l && a.status === "active" ? (
                            <>
                              <div className="mono" style={{ marginBottom: 6 }}>{ada(l.spentThisPeriod)} of {ada(l.perPeriod)} ADA spent, {ada(l.leftThisPeriod)} ADA left this period</div>
                              <div className="bar" role="img" aria-label={`${ada(l.spentThisPeriod)} of ${ada(l.perPeriod)} ADA spent`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                            </>
                          ) : "—"}
                        </td>
                        <td data-label="Resets" className="mono" style={{ whiteSpace: "nowrap" }}>{a.periodEndsAt && a.status === "active" ? when(a.periodEndsAt) : "—"}</td>
                        <td data-label="Expires" className="mono" style={{ whiteSpace: "nowrap" }}>{a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="ph"><h2>Payments</h2><span className="cap">recent, current agents</span></div>
          {history.length === 0 ? (
            <p style={{ padding: "10px 14px", margin: 0 }}>No payments yet.</p>
          ) : (
            <div className="scroll">
              <table className="t cards" style={{ minWidth: 900 }}>
                <thead><tr><th>Date</th><th>What happened</th><th>Payees</th><th>Agent's note</th></tr></thead>
                <tbody>
                  {history.map((p) => (
                    <tr key={p.txHash + p.unit}>
                      <td className="mono faint lead" style={{ whiteSpace: "nowrap" }}><Chain value={p.txHash} network={network} label={new Date(p.time).toISOString().slice(0, 10)} /></td>
                      <td className="lead">{s.labels[p.unit] ? `${s.labels[p.unit]}: ` : ""}{paymentLine(p)}.</td>
                      <td data-label="Payees" className="mono wide" style={{ whiteSpace: "nowrap" }}>{p.payees.length ? p.payees.map((x, i) => <span key={i}>{i > 0 && ", "}<Chain value={x.address} network={network} label={short(x.address)} /></span>) : "—"}</td>
                      <td data-label="Agent's note" className="wide">{p.purpose && cleanPurpose(p.purpose) ? <span>The agent's note (not verified): {cleanPurpose(p.purpose)}</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {cfg && (
          <section className="panel">
            <div className="ph"><h2>Owners</h2><span className="cap">{String(cfg.threshold)} of {cfg.owners.length}</span></div>
            <table className="t"><tbody>{cfg.owners.map((o) => <tr key={o}><td className="mono">key {short(o)}</td></tr>)}</tbody></table>
          </section>
        )}
      </main>
    </>,
    { "data-ready": "" },
  );
}
