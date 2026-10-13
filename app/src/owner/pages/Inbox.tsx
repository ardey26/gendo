import { useEffect, useState } from "react";
import { CML, explainTx, fromPlutusAddress, type AllowanceDatum } from "../../../../sdk/src/core/index.ts";
import { api } from "../api.ts";
import { inputsOf, livenessOf, vaultFromId } from "../chain.ts";
import { detailOf, type Detail } from "../diff.ts";
import { buildRecipe, decodeRecipe, encodeRecipe, titleOf } from "../recipes.ts";
import { inFlight, needsConfirm, statusOf, type Status } from "../status.ts";
import { Spinner } from "../../ui/Brand.tsx";
import type { PendingView } from "../types.ts";
import { ErrorNote, Shell, short, useLoad, useOwner, usePoll } from "../ui.tsx";
import { partialSign } from "../wallet.ts";

type Item = { p: PendingView; status: Status; detail?: Detail; verified: boolean; error?: string; vaultName: string };

export function Inbox() {
  const o = useOwner();
  const [sel, setSel] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const isMine = (address: string) => {
    try {
      return CML.Address.from_bech32(address).payment_cred()?.as_pub_key()?.to_hex() === o.me.pkh;
    } catch {
      return false;
    }
  };
  const items = useLoad(async (): Promise<Item[]> => {
    const rows = await api.myPending();
    const labels: Record<string, Record<string, string>> = {};
    return Promise.all(
      rows.map(async (p) => {
        const v = o.vaults.find((x) => x.policy === p.policy);
        const vaultName = v?.name ?? short(p.policy);
        try {
          if (!v) throw new Error("add this vault on the start page to check this item");
          labels[p.policy] ??= (await api.listing(p.policy))?.agents ?? {};
          const vault = vaultFromId(v.vaultId);
          const [{ utxos, verified }, live] = await Promise.all([inputsOf(o.lucid, p.cbor, o.net), p.status === "open" ? livenessOf(o.lucid, p.cbor) : Promise.resolve(undefined)]);
          const e = explainTx(p.cbor, vault, utxos, { viewer: o.me.pkh });
          const recipe = p.kind === "request" ? (p.recipe as { intentId?: string; purpose?: string; reason?: string } | null) : null;
          const detail = detailOf(e, {
            viewer: o.me.pkh, labels: labels[p.policy]!, isMine, short, recipe,
            payeesOf: (d: AllowanceDatum) => d.destinations.map((a) => fromPlutusAddress(o.net, a)),
          });
          return { p, status: statusOf(p, live, o.me.pkh, Date.now()), detail, verified, vaultName };
        } catch (x) {
          return { p, status: statusOf(p, undefined, o.me.pkh, Date.now()), verified: false, error: (x as Error).message, vaultName };
        }
      }),
    );
  }, [o.vaults]);

  useEffect(() => {
    void o.reloadInbox();
  }, [items.data]);
  // Re-check while anything is on its way to the chain or waiting for the other owners.
  usePoll(items.refresh, !busy && inFlight((items.data ?? []).map((x) => x.p), o.me.pkh));
  const list = items.data ?? [];
  const cur = list.find((x) => x.p.id === sel) ?? list.find((x) => x.status.needsYou) ?? list[0];

  const sign = async (it: Item) => {
    setBusy("Waiting for your wallet…");
    setErr(undefined);
    try {
      const w = await partialSign(o.me, it.p.cbor);
      setBusy("Submitting…");
      await api.sign(it.p.id, w);
      setConfirm(false);
      items.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const rebuild = async (it: Item) => {
    const r = decodeRecipe(it.p.recipe);
    const v = o.vaults.find((x) => x.policy === it.p.policy);
    if (!r || !v) return setErr("This proposal can't be rebuilt here.");
    setBusy("Building it again from the current chain…");
    setErr(undefined);
    try {
      const tx = await buildRecipe(o.lucid, vaultFromId(v.vaultId), r, o.me.pkh);
      const cbor = tx.toCBOR();
      const w = await partialSign(o.me, cbor);
      const next = await api.propose(it.p.policy, { cbor, witness: w, title: titleOf(r, {}), recipe: encodeRecipe(r) });
      setSel(next.id);
      items.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const need = list.filter((x) => x.status.needsYou);
  const rest = list.filter((x) => !x.status.needsYou);
  const row = (x: Item) => (
    <button key={x.p.id} type="button" className="item" onClick={() => { setSel(x.p.id); setConfirm(false); }} style={{ background: cur?.p.id === x.p.id ? "#1a1612" : "transparent" }}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%" }}>
        <span className="cap" style={{ color: x.p.kind === "request" ? "#e0452b" : "#8f8578" }}>{x.p.kind === "request" ? "Agent request" : "Change"}</span>
        <span className="cap">{x.status.left ?? ""}</span>
      </span>
      <span style={{ fontWeight: 700 }}>{x.detail?.title ?? x.p.title}</span>
      <span className="faint" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>{x.status.label === "Waiting for the chain" && <span className="spin" aria-hidden="true" />}{x.vaultName}, {x.status.label}</span>
    </button>
  );
  return (
    <Shell title={<><span style={{ fontWeight: 700, fontSize: 15 }}>Needs you</span><span className="faint">across {new Set(list.map((x) => x.p.policy)).size} vaults</span></>}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "16px 20px", alignItems: "flex-start" }} {...(items.loading ? {} : { "data-ready": "" })}>
        <section className="panel" aria-label="Items" style={{ flex: "1 1 280px", maxWidth: 360 }}>
          <div className="ph"><span className="cap">Your signature</span></div>
          {items.loading && !items.data ? <p style={{ padding: "10px 14px", margin: 0 }}><Spinner label="Reading your inbox and checking each tx on the chain…" /></p> : need.length ? need.map(row) : <p className="faint" style={{ padding: "10px 14px", margin: 0 }}>Nothing needs you.</p>}
          <div className="ph"><span className="cap">In flight and closed</span></div>
          {rest.map(row)}
          {items.error && <ErrorNote error={items.error} />}
        </section>
        {cur && (
          <section className="panel" aria-label="Detail" style={{ flex: "999 1 480px", minWidth: 0 }}>
            <div className="ph">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="cap">{cur.detail?.kind ?? (cur.p.kind === "request" ? "Agent request" : "Change")}, {cur.vaultName}</span>
                <span style={{ fontWeight: 700, fontSize: 16 }}>{cur.detail?.title ?? cur.p.title}</span>
              </div>
              <span className={`pill ${cur.status.tone === "plain" ? "" : cur.status.tone}`}>{cur.status.label === "Waiting for the chain" ? <Spinner label={cur.status.label} /> : cur.status.label}</span>
            </div>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
              {cur.error && <ErrorNote error={`Can't check this tx: ${cur.error}`} />}
              {cur.detail && (
                <>
                  <div>{cur.detail.summary}</div>
                  {!cur.verified && <div className="note faint">Devnet: inputs were read from the indexer, not checked against their tx hashes.</div>}
                  {cur.detail.warnings.map((w) => <ErrorNote key={w} error={`Careful: ${w}.`} />)}
                  {cur.detail.rows.length > 0 && (
                    <table className="t" style={{ border: "1px solid #2a241e", borderRadius: 8, borderCollapse: "separate", borderSpacing: 0 }}>
                      <thead><tr><th>{cur.detail.kind === "Agent request" ? "Field" : "Rule"}</th><th>{cur.detail.kind === "Agent request" ? "Value" : "On-chain now"}</th><th>{cur.detail.kind === "Agent request" ? "Against limit" : "After signing"}</th></tr></thead>
                      <tbody>
                        {cur.detail.rows.map((r, i) => (
                          <tr key={i}><td>{r.k}</td><td className="mono" style={{ color: r.changed && cur.detail!.kind === "Change" ? "#8f8578" : undefined, textDecoration: r.changed && cur.detail!.kind === "Change" ? "line-through" : undefined }}>{r.now || "—"}</td><td className="mono" style={{ color: r.changed ? "#e0452b" : "#b9afa0", fontWeight: r.changed ? 500 : 400 }}>{r.next || "—"}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {cur.detail.before && cur.detail.after && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 10 }}>
                      <div className="note"><div className="cap">Now</div>{cur.detail.before}</div>
                      <div className="note" style={{ borderColor: "#e0452b" }}><div className="cap">After signing</div>{cur.detail.after}</div>
                    </div>
                  )}
                  {cur.detail.money.length > 0 && (
                    <table className="t"><tbody>{cur.detail.money.map((m) => <tr key={m.label}><td>{m.label}</td><td className="num">{m.value}</td></tr>)}</tbody></table>
                  )}
                </>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #2a241e", paddingTop: 14 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div role="img" aria-label={cur.status.label} style={{ display: "flex", gap: 6 }}>
                    {cur.p.requiredSigners.map((k) => (cur.p.signedBy.includes(k) ? <span key={k} className="stamp" title={k}>印</span> : <span key={k} className="slot" title={k} />))}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span>{cur.status.label}</span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {cur.p.requiredSigners
                        .map((k) => `${k === o.me.pkh ? "You" : k === cur.p.createdBy && cur.p.kind === "request" ? "The agent" : `Owner key ${short(k)}`}: ${cur.p.signedBy.includes(k) ? "signed" : "not yet"}`)
                        .join(" · ")}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="faint">{cur.status.left ?? ""}</span>
                  {busy && <button type="button" className="btn" disabled><Spinner label={busy} /></button>}
                  {!busy && cur.status.canSign && cur.detail && (needsConfirm(cur.detail) && !confirm ? (
                    <button type="button" className="btn stop" onClick={() => setConfirm(true)}>I've read the warnings</button>
                  ) : (
                    <button type="button" className="btn pri" onClick={() => void sign(cur)}>Sign with wallet</button>
                  ))}
                  {!busy && cur.status.canRebuild && <button type="button" className="btn" onClick={() => void rebuild(cur)}>Rebuild</button>}
                </div>
              </div>
              {cur.status.hint && <div className="note">{cur.status.hint}</div>}
              {cur.status.tone === "dead" && <div className="note">{cur.p.kind === "request" ? "The agent re-files with the same intent id; the new request shows up here." : "Rebuild drafts it again against the current on-chain state; owners sign from zero."}</div>}
              {cur.status.label === "Landed" && <div className="note">Landed on Preprod. The chain now enforces the new state. <span className="mono faint">tx {short(cur.p.txHash ?? "")}</span></div>}
              <ErrorNote error={err} />
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}
