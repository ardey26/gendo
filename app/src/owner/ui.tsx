import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucidEvolution } from "../../../sdk/src/core/index.ts";
import { navigate } from "../route.ts";
import { Mark, Netband } from "../ui/Brand.tsx";
import type { MyVault } from "./api.ts";
import type { Net } from "./types.ts";
import type { Connected } from "./wallet.ts";

export type Owner = { net: Net; lucid: LucidEvolution; me: Connected; vaults: MyVault[]; reloadVaults(): Promise<void>; inboxCount: number; reloadInbox(): Promise<void>; signOut(): void };
export const OwnerCtx = createContext<Owner | null>(null);
export const useOwner = () => useContext(OwnerCtx)!;

export const short = (s: string) => (s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s);

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [s, setS] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  const quiet = useRef(false);
  useEffect(() => {
    let live = true;
    // A background refresh keeps showing the current data; a first load shows "loading".
    if (!quiet.current) setS((x) => ({ ...x, loading: true }));
    quiet.current = false;
    fn().then((data) => live && setS({ data, loading: false }), (e) => live && setS({ error: (e as Error).message, loading: false }));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return {
    ...s,
    reload: useCallback(() => setN((x) => x + 1), []),
    refresh: useCallback(() => {
      quiet.current = true;
      setN((x) => x + 1);
    }, []),
  };
}

/** Run `fn` every `ms` while `active`. */
export function usePoll(fn: () => void, active: boolean, ms = 5_000) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [active, fn, ms]);
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="err" role="alert" style={{ background: "#15120f", border: "1px solid #3a332b", borderRadius: 8 }}>
      <span style={{ display: "flex", gap: 10, alignItems: "center" }}><span className="ico" style={{ background: "#e0452b", color: "#efe7d8" }}>!</span><span style={{ fontWeight: 700 }}>{error}</span></span>
    </div>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn" style={{ minHeight: 24, padding: "2px 8px", fontSize: 12 }} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}>
      {done ? "Copied" : label}
    </button>
  );
}

/** You, then the next owners in order, up to the threshold: a sensible first pick to change. */
export const defaultSigners = (owners: string[], threshold: number, me: string) => [me, ...owners.filter((o) => o !== me)].slice(0, Math.max(1, threshold));

/** Pick exactly `threshold` co-signers; the proposer is always one of them. */
export function Signers({ owners, threshold, me, value, onChange }: { owners: string[]; threshold: number; me: string; value: string[]; onChange(v: string[]): void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <legend className="cap" style={{ marginBottom: 6 }}>Who signs ({value.length} of {threshold} picked)</legend>
      {owners.map((o) => (
        <label key={o} className="opt" style={{ border: "1px solid #2a241e" }}>
          <input type="checkbox" checked={value.includes(o)} disabled={o === me} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} />
          <span className="mono">{o === me ? "You" : `key ${short(o)}`}</span>
        </label>
      ))}
      {value.length !== threshold && <span className="hint" style={{ gridColumn: "auto" }}>Pick exactly {threshold}. Only the owners you pick can sign this proposal.</span>}
    </fieldset>
  );
}

export function Shell({ policy, tab, title, actions, children }: { policy?: string; tab?: string; title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const o = useOwner();
  const v = policy ? o.vaults.find((x) => x.policy === policy) : undefined;
  const nav = (to: string, label: string, on: boolean, extra?: ReactNode) => (
    <Link to={to} className={on ? "nav on" : "nav"}>{label}{extra}</Link>
  );
  return (
    <div className="app">
      <Netband />
      <div className="shell">
        <nav className="side" aria-label="Main">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 10px 12px" }}><Mark /><span style={{ fontWeight: 900, fontSize: 15 }}>gendo</span></div>
          <div className="sidecap cap">Inbox</div>
          {nav("/inbox", "Needs you", location.pathname === "/inbox", o.inboxCount ? <span className="count">{o.inboxCount}</span> : null)}
          {policy && (
            <>
              <div className="sidecap cap">{v?.name ?? short(policy)}</div>
              {(["agents", "activity", "treasury", "settings"] as const).map((t) => nav(`/v/${policy}/${t}`, t[0]!.toUpperCase() + t.slice(1), tab === t))}
              <a className="nav" href={`/w/${policy}`}>Public page</a>
            </>
          )}
          <div className="sidecap cap">Account</div>
          {nav("/", "All vaults", location.pathname === "/")}
          <div style={{ flexGrow: 1, minHeight: 16 }} />
          <div style={{ borderTop: "1px solid #2a241e", padding: "12px 10px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 12 }}>{short(o.me.address)}</span>
            <span className="faint" style={{ fontSize: 12 }}>{o.me.name}</span>
            <button type="button" className="btn" onClick={o.signOut} style={{ alignSelf: "flex-start", minHeight: 26, padding: "2px 8px", fontSize: 12 }}>Disconnect</button>
          </div>
        </nav>
        <div className="content">
          <div className="top"><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{title}</div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div></div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** A status as one icon (its words in the tooltip). `spinning`: false when another spinner is showing. */
export function StatusIcon({ status, spinning }: { status: { label: string; tone: string; needsYou: boolean; hint?: string }; spinning: boolean }) {
  const svg = (color: string, path: ReactNode) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
  );
  const waitingChain = status.label === "Waiting for the chain";
  const icon =
    status.label === "Landed" ? svg("#b9afa0", <><circle cx="10" cy="10" r="8" /><path d="M6.5 10.2l2.4 2.3 4.6-5" /></>)
    : status.tone === "dead" ? svg("#e0452b", <><circle cx="10" cy="10" r="8" /><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" /></>)
    : waitingChain ? (spinning ? <span className="spin" aria-hidden="true" style={{ width: 16, height: 16 }} /> : svg("#8f8578", <><circle cx="10" cy="10" r="8" /><path d="M10 5.5V10l3 2" /></>))
    : status.needsYou ? svg("#e0452b", <path d="M12.8 3.6l3.6 3.6-8.6 8.6H4.2v-3.6z M11 5.4l3.6 3.6" />)
    : svg("#8f8578", <><circle cx="10" cy="10" r="8" /><path d="M10 5.5V10l3 2" /></>);
  return (
    <span role="img" aria-label={status.label} title={status.label} style={{ display: "inline-flex", alignItems: "center" }}>
      {icon}
    </span>
  );
}
