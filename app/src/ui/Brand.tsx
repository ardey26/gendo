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
    </div>
  );
}
