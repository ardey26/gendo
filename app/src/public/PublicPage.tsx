// app/src/public/PublicPage.tsx
import { useEffect, useState } from "react";
import { allowanceHistory, readVault, type Get, type PaymentView, type ReadNetwork, type VaultView } from "../../../sdk/src/read/index.ts";
import { ada, allowanceSentence, cleanPurpose, paymentLine } from "./format.ts";

const get: Get = async (path) => {
  const r = await fetch(`/chain${path}`);
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error("The chain is unavailable right now. Try again in a minute.");
  return r.json();
};

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "missing" }
  | { phase: "ready"; vault: VaultView; name?: string; listed: boolean; history: PaymentView[] };

export function PublicPage({ policy, network }: { policy: string; network: ReadNetwork }) {
  const [s, setS] = useState<State>({ phase: "loading" });
  useEffect(() => {
    (async () => {
      const tip = (await get("/blocks/latest")) as { time: number } | undefined;
      const vault = await readVault(get, policy, network, tip ? tip.time * 1000 : Date.now());
      if (!vault) return setS({ phase: "missing" });
      const listing = await fetch(`/public/${policy}`).then((r) => (r.ok ? (r.json() as Promise<{ name: string; listed: boolean }>) : undefined));
      const history = (
        await Promise.all(vault.allowances.filter((a) => a.status !== "malformed").map((a) => allowanceHistory(get, a.unit, vault.address, a.txHash)))
      ).flat().sort((a, b) => b.time - a.time);
      setS({ phase: "ready", vault, name: listing?.name, listed: listing?.listed === true, history });
    })().catch((e) => setS({ phase: "error", message: (e as Error).message }));
  }, [policy, network]);

  useEffect(() => {
    if (s.phase !== "ready" || s.listed) return;
    const m = document.createElement("meta");
    m.name = "robots";
    m.content = "noindex";
    document.head.append(m);
    return () => m.remove();
  }, [s]);

  if (s.phase === "loading") return <main><p>Reading the chain…</p></main>;
  if (s.phase === "error") return <main data-error><p>{s.message}</p></main>;
  if (s.phase === "missing") return <main data-ready><h1>No vault found</h1><p>Nothing lives at this vault id on preprod.</p></main>;
  const { vault, history } = s;
  return (
    <main data-ready>
      <h1>{s.name ?? "A gendo vault"}</h1>
      <p>{vault.config ? `${vault.config.paused ? "Paused: no agent can spend." : "Active."} Changes need ${vault.config.threshold} of ${vault.config.owners.length} owners.` : "Config unreadable."}</p>
      <p>Treasury: {ada(vault.treasuryLovelace)} ADA</p>
      <h2>Agents</h2>
      {vault.allowances.length === 0 && <p>No agents yet.</p>}
      {vault.allowances.map((a) => {
        const l = a.caps.find((c) => c.unit === "lovelace");
        return (
          <section key={a.unit}>
            <p>{allowanceSentence(a)}</p>
            {a.status !== "malformed" && <p>Status: {a.status === "paused" ? "paused (the vault is paused)" : a.status}.</p>}
            {l && a.status === "active" && (
              <p>
                {ada(l.leftThisPeriod)} of {ada(l.perPeriod)} ADA left this period, resets {new Date(a.periodEndsAt!).toISOString().replace("T", " ").slice(0, 16)} UTC.
              </p>
            )}
          </section>
        );
      })}
      <h2>Payments</h2>
      {history.length === 0 && <p>No payments yet.</p>}
      <ul>
        {history.map((p) => (
          <li key={p.txHash}>
            {new Date(p.time).toISOString().slice(0, 10)}: {paymentLine(p)}.
            {p.purpose && cleanPurpose(p.purpose) && (
              <blockquote>
                <small>The agent's note (not verified):</small> {cleanPurpose(p.purpose)}
              </blockquote>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
