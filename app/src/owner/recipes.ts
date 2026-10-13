// A proposal's recipe: what to build, so any required signer can rebuild it when it goes stale.
import type { AllowanceDatum } from "../../../sdk/src/core/index.ts";
import type { Grant } from "../../../sdk/src/core/owner.ts";

export type Recipe =
  | { op: "pause" }
  | { op: "unpause"; signers: string[] }
  | { op: "config"; owners: string[]; threshold: bigint; signers: string[] }
  | { op: "edit"; unit: string; next: AllowanceDatum; topUp: bigint; signers: string[] }
  | { op: "grant"; grant: Grant; signers: string[] }
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
