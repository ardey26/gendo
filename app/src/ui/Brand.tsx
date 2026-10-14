import { openNotice } from "./notice.ts";
import { explorerUrl } from "./explorer.ts";

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
