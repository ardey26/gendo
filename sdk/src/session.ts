// The paying agent's whole surface: check its budget, pay within it, ask the
// owners for more. Shared by the MCP server and the demo LLM agent. Nothing here
// holds a key or runs an owner operation: payments are signed by the signer
// daemon, and over-limit payments go to the owners as unsigned files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialToAddress, type Assets, type LucidEvolution, type Network, type UTxO } from "@lucid-evolution/lucid";
import { buildOverLimitSpend } from "./agent.js";
import { fromPlutusAddress } from "./address.js";
import { readAllowance, readConfig } from "./chain.js";
import { describeTx } from "./cosign.js";
import { AlreadyPaid, assertNotPaid, blockfrostQuery, FileJournal, type ChainQuery, type IntentJournal } from "./idempotency.js";
import { INTENT_LABEL } from "./intent.js";
import { floorDiv, unitOf } from "./limits.js";
import { offlineTtlMs } from "./owner.js";
import { payOnce } from "./pay.js";
import { connect, providerFromEnv } from "./provider.js";
import { requestWitness } from "./signer/client.js";
import { makeVault, type Vault } from "./vault.js";

export type AgentSession = {
  lucid: LucidEvolution;
  vault: Vault;
  /** The allowance this agent pays from. */
  unit: string;
  home: string;
  q: ChainQuery;
  journal: IntentJournal;
  sign: (txCbor: string) => Promise<string>;
  refScript?: { txHash: string; outputIndex: number };
};

/** `home` is a VAULT_HOME joined to the vault (`vault join <id>`); it holds no key. */
export async function openSession(opts: { home: string; unit: string; signerSocket: string }): Promise<AgentSession> {
  const statePath = join(opts.home, "state.json");
  if (!existsSync(statePath)) throw new Error(`${statePath} not found: run \`vault join <id>\` with VAULT_HOME=${opts.home}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const cfg = providerFromEnv();
  const lucid = await connect(cfg);
  if (state.network !== lucid.config().network) throw new Error(`vault is on ${state.network}, VAULT_NETWORK is ${lucid.config().network}`);
  return {
    lucid,
    vault: makeVault(lucid.config().network!, state.seed),
    unit: opts.unit,
    home: opts.home,
    q: blockfrostQuery(cfg.blockfrostUrl, cfg.blockfrostProjectId),
    journal: new FileJournal(join(opts.home, "intents.jsonl")),
    sign: (cbor) => requestWitness(opts.signerSocket, cbor),
    refScript: state.refScript,
  };
}

const ada = (lovelace: bigint) => Number(lovelace) / 1e6;
/** Amounts an LLM reads easily: ADA for lovelace, raw quantity for tokens. */
const human = (unit: string, q: bigint) => (unit === "lovelace" ? { asset: "ADA", amount: ada(q) } : { asset: unit, amount: Number(q) });

/** The agent's key address must hold a pure-ADA UTxO: the ledger takes collateral only from a key address. */
async function agentWallet(s: AgentSession, agentPkh: string) {
  const addr = credentialToAddress(s.lucid.config().network!, { type: "Key", hash: agentPkh });
  const collateral = (await s.lucid.utxosAt(addr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef);
  if (!collateral) throw Object.assign(new Error(`agent address ${addr} needs a pure-ADA UTxO for collateral (a few tADA)`), { code: "NO_COLLATERAL" });
  s.lucid.selectWallet.fromAddress(addr, [collateral]);
  const [ref] = s.refScript ? await s.lucid.utxosByOutRef([s.refScript]) : [];
  return { collateral, refScript: ref?.scriptRef ? (ref as UTxO) : undefined };
}

/** What the agent may spend right now, and the rules it spends under. */
export async function budget(s: AgentSession) {
  const [al, cfg, tip] = await Promise.all([readAllowance(s.lucid, s.vault, s.unit), readConfig(s.lucid, s.vault), s.q.tipMs()]);
  const d = al.datum;
  const now = BigInt(tip ?? Date.now());
  const started = now >= d.windowStart;
  const k = started ? floorDiv(now - d.windowStart, d.periodMs) : 0n;
  const windowStart = d.windowStart + k * d.periodMs;
  const network = s.lucid.config().network as Network;
  return {
    paused: cfg.config.paused,
    expires_at: new Date(Number(d.expiresAt)).toISOString(),
    period_resets_at: new Date(Number(windowStart + d.periodMs)).toISOString(),
    max_fee_ada: ada(d.maxFee),
    limits: d.caps.map((c, i) => {
      const unit = unitOf(c.policy, c.name);
      const spent = k === 0n ? d.spent[i]! : 0n;
      const left = c.windowCap - spent;
      return {
        asset: human(unit, 0n).asset,
        per_payment: human(unit, c.txCap).amount,
        per_period: human(unit, c.windowCap).amount,
        spent_this_period: human(unit, spent).amount,
        left_this_period: human(unit, left).amount,
        largest_payment_now: human(unit, left < c.txCap ? left : c.txCap).amount,
      };
    }),
    approved_payees: d.destinations.map((a) => fromPlutusAddress(network, a)),
    held_in_allowance: Object.fromEntries(Object.entries(al.utxo.assets).map(([u, q]) => [u === "lovelace" ? "ADA" : u, human(u, q).amount])),
    note: "The fee counts toward the ADA limits. Payments over a limit need the owners: use request_approval.",
  };
}

/** What to do about each refusal, phrased for an agent. */
export const NEXT_STEP: Record<string, string> = {
  TX_CAP: "Over the per-payment limit. Call request_approval with the same intent_id; don't split it into smaller payments.",
  WINDOW_CAP: "Over this period's budget. Wait for period_resets_at (see get_budget), or call request_approval.",
  DESTINATION: "Payee is not approved. Do not retry. Report it; only the owners can approve a payee.",
  PAUSED: "The owners paused all spending. Stop and report it.",
  TIME: "Too close to a period boundary or the expiry. Retry after the boundary, or report an expiring allowance.",
  EXPIRED: "The allowance has expired. Stop and report it.",
  FEE: "The fee is above the allowed max. Report it; don't raise fees.",
  UNCAPPED_ASSET: "That asset isn't in the allowance. Report it.",
  NO_COLLATERAL: "The agent's own address needs a few tADA for collateral. Report it to the operator.",
  SIGNER_REFUSED: "The signer refused it: its own rate or daily limit, its payee list, or a different tx for an intent it already signed. Report the reason; don't retry with a new intent_id.",
  SCRIPT_OR_LEDGER: "Rejected by the chain. Report it with the reason; don't retry blindly.",
};

const toAssets = (amount_ada?: number, asset?: { unit: string; quantity: number }): Assets => {
  if (asset) return { [asset.unit]: BigInt(asset.quantity), ...(amount_ada ? { lovelace: BigInt(Math.round(amount_ada * 1e6)) } : {}) };
  if (amount_ada === undefined || !(amount_ada > 0)) throw new Error("amount_ada must be positive");
  return { lovelace: BigInt(Math.round(amount_ada * 1e6)) };
};

export type PaymentRequest = { to: string; amount_ada?: number; asset?: { unit: string; quantity: number }; intent_id: string; purpose: string };

/** Pay once per intent id. Never throws for a refusal: returns it with the next step. */
export async function pay(s: AgentSession, p: PaymentRequest) {
  try {
    const w = await agentWallet(s, (await readAllowance(s.lucid, s.vault, s.unit)).datum.agent);
    const r = await payOnce(
      {
        lucid: s.lucid,
        vault: s.vault,
        allowanceUnit: s.unit,
        collateral: w.collateral,
        refScript: w.refScript,
        payments: [{ to: p.to, assets: toAssets(p.amount_ada, p.asset) }],
        intentId: p.intent_id,
        purpose: p.purpose,
        ref: p.intent_id,
      },
      { q: s.q, journal: s.journal, sign: s.sign },
    );
    return r.status === "paid"
      ? { status: "paid" as const, tx: r.txHash, fee_ada: ada(r.built.fee) }
      : { status: "already_paid" as const, tx: r.txHash, note: "This intent_id was paid before; nothing new was sent." };
  } catch (e) {
    const err = e as Error & { code?: string };
    const code = err.code ?? (err.message.startsWith("signer refused:") ? "SIGNER_REFUSED" : "SCRIPT_OR_LEDGER");
    return {
      status: "blocked" as const,
      code,
      reason: err.message.split("\n")[0]?.slice(0, 300),
      next_step: NEXT_STEP[code] ?? NEXT_STEP.SCRIPT_OR_LEDGER,
    };
  }
}

/**
 * Prepare an over-limit payment for the owners. Writes an unsigned tx to
 * `<home>/approvals/<intent_id>.cbor` that owners check (`vault tx describe`) and
 * sign on their own machines; the agent operator adds the agent's witness.
 */
export async function requestApproval(s: AgentSession, p: PaymentRequest & { reason: string }) {
  try {
    const current = await readAllowance(s.lucid, s.vault, s.unit);
    await assertNotPaid(s.q, s.journal, s.unit, current.utxo.txHash, p.intent_id, INTENT_LABEL);
    const config = await readConfig(s.lucid, s.vault);
    const w = await agentWallet(s, current.datum.agent);
    const built = await buildOverLimitSpend({
      lucid: s.lucid,
      vault: s.vault,
      allowance: current,
      config,
      collateral: w.collateral,
      refScript: w.refScript,
      tipMs: await s.q.tipMs(),
      payments: [{ to: p.to, assets: toAssets(p.amount_ada, p.asset) }],
      intentId: p.intent_id,
      purpose: `${p.purpose} (owner approval: ${p.reason.slice(0, 80)})`,
      cosigners: config.config.owners.slice(0, Number(config.config.threshold)),
      // Owners sign on their own machines: give them hours, not the agent's minutes.
      validityMs: Number(process.env.VAULT_TX_TTL_MS ?? offlineTtlMs(s.lucid.config().network!)),
    });
    const dir = join(s.home, "approvals");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${p.intent_id.replace(/[^\w.-]/g, "_")}.cbor`);
    writeFileSync(file, built.tx.toCBOR());
    const ttlSlot = describeTx(built.tx.toCBOR()).validity.ttlSlot;
    return {
      status: "awaiting_owners" as const,
      file,
      expires_at: ttlSlot ? new Date(s.lucid.slotToUnixTime(Number(ttlSlot))).toISOString() : undefined,
      note: "Hand this file to the owners. Any other payment from this allowance before they submit it makes it stale; if they report it dead, call request_approval again with the same intent_id.",
    };
  } catch (e) {
    if (e instanceof AlreadyPaid) return { status: "already_paid" as const, tx: e.txHash };
    const err = e as Error & { code?: string };
    return { status: "blocked" as const, code: err.code ?? "ERROR", reason: err.message.split("\n")[0]?.slice(0, 300) };
  }
}
