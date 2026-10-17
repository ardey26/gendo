import { openNotice } from "./notice.ts";
import { explorerUrl } from "./explorer.ts";
import { seedHue } from "./avatar.ts";

// The 限度 seal mark and the network band, as in the draft.
export function Mark() {
  return (
    <span className="kj" aria-hidden="true" style={{ display: "inline-flex", width: 26, height: 26, alignItems: "center", justifyContent: "center", background: "#e0452b", color: "#efe7d8", borderRadius: 5, boxShadow: "inset 0 0 0 2px #0f0d0a, inset 0 0 0 3px #e0452b", fontSize: 10, writingMode: "vertical-rl" }}>
      限度
    </span>
  );
}
export function Netband() {
  return (
    <div className="netband" role="status">
      <b>Preprod test network</b>
      <span>Test ADA only. Nothing here has real value.</span>
      <button type="button" className="netlink" onClick={openNotice}>Early preview</button>
    </div>
  );
}

/** A small spinner with its label, for anything that is waiting. */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="busy" role="status">
      <span className="spin" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A transaction hash or address, linked to the explorer when there is one; `label` is what shows. */
export function Chain({ value, network, label }: { value: string; network: string; label?: string }) {
  const url = explorerUrl(network, value);
  if (!url) return <>{label ?? value}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mono" title={`${value} on Cardanoscan (preprod)`} style={{ textDecorationColor: "#3a332b", textUnderlineOffset: 3 }}>
      {label ?? value}
    </a>
  );
}

const AVATAR = {
  // A small robot: head, antenna, two eyes.
  agent: "M5.5 7.5h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM10 7.5V5M10 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM7.5 11v1.2M12.5 11v1.2",
  // A safe: body, dial, feet.
  vault: "M4.5 3.5h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM10 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 9.5l1.4-1.4M6 15.5V17M14 15.5V17",
};

/** An agent's robot or a vault's safe, tinted with a color seeded from its id. */
export function Avatar({ id, kind, size = 28 }: { id: string; kind: keyof typeof AVATAR; size?: number }) {
  const h = seedHue(id);
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", width: size, height: size, borderRadius: Math.round(size / 4), alignItems: "center", justifyContent: "center", flexShrink: 0, background: `hsl(${h} 38% 16%)`, border: `1px solid hsl(${h} 38% 30%)`, color: `hsl(${h} 70% 72%)` }}>
      <svg width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={AVATAR[kind]} /></svg>
    </span>
  );
}
