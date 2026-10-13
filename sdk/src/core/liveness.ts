// sdk/src/core/liveness.ts
// Can a tx still land? Checked before anyone spends a signature on it, and by the
// app's inbox. Any input spent by another tx, or a passed TTL, makes it dead for good.
import type { ChainQuery, TxFacts } from "./idempotency.js";

export type Liveness = { state: "landed"; hash: string } | { state: "dead"; reason: string } | { state: "submittable"; expiresAtMs: number };

/** `isUnspent` answers for providers without a spender index (undefined: can't tell). */
export async function liveness(
  q: ChainQuery,
  t: TxFacts,
  nowMs: number,
  isUnspent: (txHash: string, index: number) => Promise<boolean | undefined>,
): Promise<Liveness> {
  if (await q.txExists(t.hash)) return { state: "landed", hash: t.hash };
  for (const i of t.inputs) {
    const by = await q.spenderOf(i.txHash, i.index);
    if (by === t.hash) return { state: "landed", hash: t.hash };
    if (typeof by === "string") return { state: "dead", reason: `its input ${i.txHash}#${i.index} was spent by tx ${by}` };
    if (by === undefined && (await isUnspent(i.txHash, i.index)) === false)
      return { state: "dead", reason: `its input ${i.txHash}#${i.index} was spent by another tx` };
  }
  if (nowMs >= t.ttlMs) return { state: "dead", reason: `it expired at ${new Date(t.ttlMs).toISOString()}` };
  return { state: "submittable", expiresAtMs: t.ttlMs };
}
