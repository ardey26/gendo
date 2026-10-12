// Signer policy (edges O1, O2, O3). Pure function over the tx CBOR + state so it
// can be unit-tested without sockets. The chain enforces the hard caps; this
// layer adds what the chain cannot: rate limits, a local budget, short TTLs,
// and a second opinion on destinations from a config the LLM cannot edit.
import { CML, type Assets } from "@lucid-evolution/lucid";
import { add, valueToAssets } from "../../core/assets.js";

export type SignerPolicy = {
  agentKeyHash: string;
  vaultAddress: string;
  /** The one allowance this signer serves (policy id + token name). The continuing output must carry it. */
  allowanceUnit: string;
  /** bech32 destinations, exact. Should mirror (or be stricter than) the on-chain allowlist. */
  destinations: string[];
  maxTxPerHour: number;
  /** Rolling 24 h budget per unit (`lovelace` or policy id + name). An asset with no entry may not leave. */
  maxPerDay: Assets;
  /** Refuse txs whose TTL is further than this from now (pre-signed tx shelf life). */
  maxTtlMs: number;
  allowCoSigned: boolean;
  slot: { zeroTime: number; zeroSlot: number; slotLength: number };
};

export type { SignerState } from "./state.js";
import type { SignerState } from "./state.js";

export type Decision = { ok: true; out: Assets } | { ok: false; reason: string };

export function evaluate(policy: SignerPolicy, state: SignerState, txCbor: string, now: number): Decision {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch {
    return { ok: false, reason: "not a transaction" };
  }
  const body = tx.body();

  const req = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; req && i < req.len(); i++) signers.push(req.get(i).to_hex());
  if (!signers.includes(policy.agentKeyHash)) return { ok: false, reason: "agent key is not a required signer" };
  const coSigned = signers.length > 1;
  if (coSigned && !policy.allowCoSigned) return { ok: false, reason: "co-signed spends are disabled for this signer" };

  // Agent and over-limit spends both draw from the allowance UTxO alone.
  if (body.inputs().len() !== 1) return { ok: false, reason: "a spend must have exactly one input, the allowance" };
  if (body.mint() || body.withdrawals() || body.certs()) return { ok: false, reason: "mint/withdrawal/certificate not allowed" };

  const ttl = body.ttl();
  if (ttl === undefined) return { ok: false, reason: "tx has no upper validity bound" };
  const ttlMs = policy.slot.zeroTime + (Number(ttl) - policy.slot.zeroSlot) * policy.slot.slotLength;
  if (ttlMs - now > policy.maxTtlMs) return { ok: false, reason: `ttl ${ttlMs - now}ms exceeds signer max ${policy.maxTtlMs}ms` };

  // Everything that leaves: the fee plus every asset paid to a destination.
  const paid: Assets[] = [{ lovelace: body.fee() }];
  const continuing: CML.TransactionOutput[] = [];
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const addr = o.address().to_bech32();
    if (addr === policy.vaultAddress) {
      continuing.push(o);
      continue;
    }
    if (!policy.destinations.includes(addr)) return { ok: false, reason: `destination ${addr} not allowed by signer policy` };
    paid.push(valueToAssets(o.amount()));
  }
  if (continuing.length !== 1) return { ok: false, reason: "expected exactly one continuing output at the vault" };
  // With one input and no mint, the continuing output can only hold tokens that input held,
  // so this pins the input to the configured allowance.
  if (valueToAssets(continuing[0]!.amount())[policy.allowanceUnit] !== 1n)
    return { ok: false, reason: `continuing output does not carry allowance ${policy.allowanceUnit}` };
  const out = add(...paid);

  const hourAgo = now - 3_600_000;
  const dayAgo = now - 86_400_000;
  const recent = state.signed.filter((s) => s.at > hourAgo).length;
  if (recent >= policy.maxTxPerHour) return { ok: false, reason: `rate limit: ${recent} txs in the last hour` };
  const spentToday = add(...state.signed.filter((s) => s.at > dayAgo).map((s) => s.assets));
  for (const [unit, q] of Object.entries(out)) {
    const max = policy.maxPerDay[unit];
    if (max === undefined) return { ok: false, reason: `daily budget: ${unit} has no daily limit in the signer policy` };
    const before = spentToday[unit] ?? 0n;
    if (before + q > max) return { ok: false, reason: `daily budget: ${unit} ${before} + ${q} > ${max}` };
  }

  return { ok: true, out };
}
