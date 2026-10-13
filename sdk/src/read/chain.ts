// sdk/src/read/chain.ts
// Vault state and payment history from a Blockfrost-style REST API (through
// the server's /chain proxy in the app). No Lucid: datums are decoded by
// ./decode.ts, budget arithmetic reuses ../core/limits.ts.
import type { ConfigDatum } from "../core/data.js";
import type { Intent } from "../core/intent.js";
import { utf8ToHex } from "../core/bytes.js";
import { floorDiv, unitOf } from "../core/limits.js";
import { addressToBech32, allowanceFromCbor, configFromCbor, scriptAddress, type ReadNetwork } from "./decode.js";

export type Get = (path: string) => Promise<unknown | undefined>;
export type CapView = { unit: string; perPayment: bigint; perPeriod: bigint; spentThisPeriod: bigint; leftThisPeriod: bigint };
export type AllowanceView = {
  unit: string;
  txHash: string;
  lovelace: bigint;
  status: "active" | "expired" | "not started" | "malformed";
  agent?: string;
  caps: CapView[];
  payees: string[];
  periodMs?: bigint;
  periodEndsAt?: number;
  expiresAt?: number;
  maxFee?: bigint;
};
export type VaultView = { policy: string; address: string; config: ConfigDatum | null; treasuryLovelace: bigint; allowances: AllowanceView[] };
export type PaymentView = {
  txHash: string;
  time: number;
  kind: "agent" | "co-signed" | "owner";
  purpose?: string;
  intentId?: string;
  payees: { address: string; lovelace: bigint }[];
};

type BfAmount = { unit: string; quantity: string };
type BfUtxo = { tx_hash: string; output_index: number; amount: BfAmount[]; inline_datum: string | null };
const qty = (amount: BfAmount[], unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");

async function utxosAt(get: Get, address: string): Promise<BfUtxo[]> {
  const out: BfUtxo[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (await get(`/addresses/${address}/utxos?page=${page}&count=100`)) as BfUtxo[] | undefined;
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function allowanceView(u: BfUtxo, unit: string, network: ReadNetwork, now: bigint): AllowanceView {
  const base = { unit, txHash: u.tx_hash, lovelace: qty(u.amount, "lovelace"), caps: [], payees: [] };
  let d;
  try {
    if (!u.inline_datum) throw new Error("no inline datum");
    d = allowanceFromCbor(u.inline_datum);
  } catch {
    return { ...base, status: "malformed" };
  }
  const started = now >= d.windowStart;
  const k = started && d.periodMs > 0n ? floorDiv(now - d.windowStart, d.periodMs) : 0n;
  return {
    ...base,
    agent: d.agent,
    status: !started ? "not started" : now >= d.expiresAt ? "expired" : "active",
    caps: d.caps.map((c, i) => {
      const spent = k === 0n ? (d.spent[i] ?? 0n) : 0n;
      return { unit: unitOf(c.policy, c.name), perPayment: c.txCap, perPeriod: c.windowCap, spentThisPeriod: spent, leftThisPeriod: c.windowCap - spent };
    }),
    payees: d.destinations.map((a) => addressToBech32(a, network)),
    periodMs: d.periodMs,
    periodEndsAt: Number(d.windowStart + (k + 1n) * d.periodMs),
    expiresAt: Number(d.expiresAt),
    maxFee: d.maxFee,
  };
}

/** The vault at `policy`, or undefined when nothing is at its address. */
export async function readVault(get: Get, policy: string, network: ReadNetwork, nowMs: number): Promise<VaultView | undefined> {
  const address = scriptAddress(policy, network);
  const utxos = await utxosAt(get, address);
  if (!utxos.length) return undefined;
  const configUnit = policy + utf8ToHex("config");
  const now = BigInt(nowMs);
  let config: ConfigDatum | null = null;
  let treasuryLovelace = 0n;
  const allowances: AllowanceView[] = [];
  for (const u of utxos) {
    const vaultUnits = u.amount.filter((a) => a.unit.startsWith(policy) && a.unit !== "lovelace");
    if (vaultUnits.some((a) => a.unit === configUnit)) {
      try {
        config = configFromCbor(u.inline_datum ?? "");
      } catch {
        config = null;
      }
    } else if (vaultUnits.length === 1 && vaultUnits[0]!.quantity === "1") allowances.push(allowanceView(u, vaultUnits[0]!.unit, network, now));
    else if (vaultUnits.length === 0) treasuryLovelace += qty(u.amount, "lovelace");
  }
  return { policy, address, config, treasuryLovelace, allowances };
}

type BfTxUtxos = { inputs: { tx_hash: string; amount: BfAmount[] }[]; outputs: { address: string; amount: BfAmount[] }[] };

/** Newest first: each tx that spent this allowance, back to (not including) the grant. */
export async function allowanceHistory(get: Get, unit: string, vaultAddress: string, fromTx: string, lookback = 20): Promise<PaymentView[]> {
  const out: PaymentView[] = [];
  let cur: string | undefined = fromTx;
  for (let i = 0; cur && i < lookback; i++) {
    const io = (await get(`/txs/${cur}/utxos`)) as BfTxUtxos | undefined;
    const prev = io?.inputs.find((x) => x.amount.some((a) => a.unit === unit));
    if (!io || !prev) break; // the grant mints the token: nothing older to show
    const meta = (await get(`/txs/${cur}/metadata`)) as { label: string; json_metadata: { j?: string[] } }[] | undefined;
    let intent: Partial<Intent> | undefined;
    try {
      const j = meta?.find((m) => m.label === "7041")?.json_metadata.j;
      intent = j ? (JSON.parse(j.join("")) as Partial<Intent>) : undefined;
    } catch {
      intent = undefined;
    }
    const tx = (await get(`/txs/${cur}`)) as { block_time: number } | undefined;
    out.push({
      txHash: cur,
      time: (tx?.block_time ?? 0) * 1000,
      kind: intent?.kind === "agent_spend" ? "agent" : intent?.kind === "co_signed_spend" ? "co-signed" : "owner",
      ...(intent?.purpose !== undefined ? { purpose: intent.purpose } : {}),
      ...(intent?.id !== undefined ? { intentId: intent.id } : {}),
      payees: io.outputs.filter((o) => o.address !== vaultAddress).map((o) => ({ address: o.address, lovelace: qty(o.amount, "lovelace") })),
    });
    cur = prev.tx_hash;
  }
  return out;
}
