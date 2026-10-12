// Durable signer state: rate/budget counters and the intent-id dedupe table.
// Saved atomically (write temp file, rename) BEFORE a witness is released, so a
// crash or restart can never forget a signature it handed out.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Assets } from "@lucid-evolution/lucid";
import { fmt } from "../../core/assets.js";
import type { TxFacts } from "../../core/idempotency.js";

export type IntentRecord = TxFacts & { at: number };

export type SignerState = {
  /** Every asset each signed tx let leave (fee included), for the rolling budgets. */
  signed: { at: number; assets: Assets }[];
  /** intent id -> the last tx the signer signed for it */
  intents: Record<string, IntentRecord>;
};

export const emptyState = (): SignerState => ({ signed: [], intents: {} });

export function loadState(path: string | undefined): SignerState {
  if (!path || !existsSync(path)) return emptyState();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    signed: (raw.signed ?? []).map((s: { at: number; assets?: Record<string, string>; lovelace?: string }) => ({
      at: s.at,
      // Files written before per-asset budgets recorded lovelace only.
      assets: s.assets
        ? Object.fromEntries(Object.entries(s.assets).map(([u, q]) => [u, BigInt(q)]))
        : { lovelace: BigInt(s.lovelace ?? "0") },
    })),
    intents: raw.intents ?? {},
  };
}

export function saveState(path: string | undefined, s: SignerState, now: number) {
  if (!path) return;
  // Counters older than the longest window (24 h) are no longer needed.
  const keep = s.signed.filter((x) => x.at > now - 86_400_000);
  const body = JSON.stringify({ signed: keep.map((x) => ({ at: x.at, assets: fmt(x.assets) })), intents: s.intents });
  writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
