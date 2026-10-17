// A proposal's recipe: what to build, so any required signer can rebuild it when it goes stale.
import type { AllowanceDatum, Explanation } from "../../../sdk/src/core/index.ts";
import type { Grant } from "../../../sdk/src/core/owner.ts";
import { listAllowances, owner, readAllowance, readConfig, treasuryUtxos, type LucidEvolution, type TxSignBuilder, type Vault } from "../../../sdk/src/core/index.ts";

export type Recipe =
  | { op: "pause" }
  | { op: "unpause"; signers: string[] }
  | { op: "config"; owners: string[]; threshold: bigint; signers: string[] }
  | { op: "edit"; unit: string; next: AllowanceDatum; topUp: bigint; signers: string[] }
  | { op: "grant"; grant: Grant & { collateral?: bigint }; signers: string[] }
  | { op: "revoke"; unit: string; signers: string[] }
  | { op: "fund"; lovelace: bigint };

export const encodeRecipe = (r: Recipe): unknown => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v)));

export function decodeRecipe(x: unknown): Recipe | undefined {
  try {
    const r = JSON.parse(JSON.stringify(x), (_k, v) => (v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$n === "string" && /^-?\d+$/.test(v.$n) ? BigInt(v.$n) : v)) as Recipe;
    const signers = (r as { signers?: unknown }).signers;
    const okSigners = Array.isArray(signers) && signers.every((s) => typeof s === "string" && /^[0-9a-f]{56}$/.test(s));
    switch (r?.op) {
      case "pause": return r;
      case "fund": return typeof r.lovelace === "bigint" ? r : undefined;
      case "unpause": return okSigners ? r : undefined;
      case "config": return okSigners && Array.isArray(r.owners) && typeof r.threshold === "bigint" ? r : undefined;
      case "edit": return okSigners && typeof r.unit === "string" && r.next && typeof r.topUp === "bigint" ? r : undefined;
      case "grant": return okSigners && r.grant ? r : undefined;
      case "revoke": return okSigners && typeof r.unit === "string" ? r : undefined;
      default: return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Build the recipe's tx with the SDK's owner builders; the connected wallet pays the fee. */
export async function buildRecipe(l: LucidEvolution, vault: Vault, r: Recipe, me: string): Promise<TxSignBuilder> {
  const cfg = await readConfig(l, vault);
  switch (r.op) {
    case "pause":
      return owner.pause(l, vault, cfg, [me]);
    case "unpause":
      return owner.unpause(l, vault, cfg, r.signers);
    case "config":
      return owner.updateConfig(l, vault, cfg, { ...cfg.config, owners: r.owners, threshold: r.threshold }, r.signers);
    case "edit":
      return owner.editAllowance(l, vault, cfg, await readAllowance(l, vault, r.unit), r.next, r.signers, r.topUp > 0n ? { lovelace: r.topUp } : {});
    case "grant": {
      const fromTreasury = (r.grant.fund.lovelace ?? 0n) > 0n ? await treasuryUtxos(l, vault) : undefined;
      const { collateral, ...grant } = r.grant;
      return (await owner.grantAllowance(l, vault, cfg, grant, r.signers, { ...(fromTreasury ? { fromTreasury } : {}), ...(collateral ? { agentCollateral: collateral } : {}) })).tx;
    }
    case "revoke": {
      const al = (await listAllowances(l, vault)).find((a) => a.unit === r.unit);
      if (!al) throw new Error("that agent's allowance isn't on chain any more");
      return owner.revokeAllowance(l, vault, cfg, { utxo: al.utxo, unit: al.unit }, r.signers);
    }
    case "fund": {
      // Funding needs no owner, but naming the funder as a signer lets it go through the inbox,
      // which submits a fully signed tx at once (no separate submit path on the server).
      const now = l.slotToUnixTime(l.currentSlot());
      return l.newTx().pay.ToAddress(vault.address, { lovelace: r.lovelace }).addSignerKey(me).validTo(now + owner.offlineTtlMs(l.config().network!)).complete();
    }
  }
}

export function titleOf(r: Recipe, labels: Record<string, string>): string {
  const n = (u: string) => labels[u] ?? `agent ${u.slice(56, 64)}`;
  switch (r.op) {
    case "pause": return "Pause all agents";
    case "unpause": return "Unpause";
    case "config": return "Change owners or threshold";
    case "edit": return `Change ${n(r.unit)}`;
    case "grant": return "Add an agent";
    case "revoke": return `Revoke ${n(r.unit)}`;
    case "fund": return "Fund the treasury";
  }
}

/** Rebuild only what the dead item was: the recipe's op (and allowance) must match what its tx changed. */
export function recipeMatches(r: Recipe, e: Explanation): boolean {
  const c = e.changes;
  switch (r.op) {
    case "pause":
      return c.length === 1 && c[0]!.kind === "config" && c[0]!.after?.paused === true;
    case "unpause":
      return c.length === 1 && c[0]!.kind === "config" && c[0]!.after?.paused === false;
    case "config":
      return c.length === 1 && c[0]!.kind === "config";
    case "edit":
      return c.length === 1 && c[0]!.kind === "edit" && c[0]!.unit === r.unit;
    case "revoke":
      return c.length === 1 && c[0]!.kind === "revoke" && c[0]!.unit === r.unit;
    case "grant":
      return c.length === 1 && c[0]!.kind === "grant";
    case "fund":
      return c.length === 0 && Object.keys(e.leavesVault).length === 0;
  }
}
