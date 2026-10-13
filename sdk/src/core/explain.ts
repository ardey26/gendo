// sdk/src/core/explain.ts
// What an owner is about to sign, computed from the tx and the chain alone: the vault
// UTxOs it spends (from the resolved inputs) against the vault UTxOs it creates. The
// app shows this, never a description someone else wrote.
import { CML, type UTxO } from "@lucid-evolution/lucid";
import { valueToAssets } from "./assets.js";
import { describeTx } from "./cosign.js";
import { allowanceFromData, configFromData, type AllowanceDatum, type ConfigDatum } from "./data.js";
import type { Intent } from "./intent.js";
import type { Vault } from "./vault.js";

export type Change =
  | { kind: "config"; before: ConfigDatum | null; after: ConfigDatum | null }
  | { kind: "grant"; unit: string; after: AllowanceDatum | null; lovelace: bigint }
  | { kind: "edit"; unit: string; before: AllowanceDatum | null; after: AllowanceDatum | null; lovelaceBefore: bigint; lovelaceAfter: bigint }
  | { kind: "revoke"; unit: string; before: AllowanceDatum | null; lovelace: bigint }
  | { kind: "spend"; unit: string; redeemer: "AgentSpend" | "CoSignedSpend"; before: AllowanceDatum | null; after: AllowanceDatum | null };

export type Explanation = {
  hash: string;
  requiredSigners: string[];
  ttlSlot?: number;
  changes: Change[];
  /** ADA the vault address loses: vault inputs minus vault outputs (owners' fees never come from the vault). */
  leavesVault: bigint;
  /** Every output not at the vault (payees, and the proposer's own change). */
  outside: { address: string; lovelace: bigint }[];
  /** The intent record, only when it hashes to the vault's spend redeemer. */
  intent?: Intent;
  warnings: string[];
};

type Out = { address: string; assets: Record<string, bigint>; datum?: string };

const tryDecode = <T>(f: (c: string) => T, cbor?: string): T | null => {
  try {
    return cbor ? f(cbor) : null;
  } catch {
    return null;
  }
};

export function explainTx(txCbor: string, vault: Vault, resolvedInputs: UTxO[]): Explanation {
  const byRef = new Map(resolvedInputs.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));
  const summary = describeTx(txCbor, {
    vault,
    inputAddresses: Object.fromEntries(resolvedInputs.map((u) => [`${u.txHash}#${u.outputIndex}`, u.address])),
  });
  const warnings: string[] = [];
  const missing = summary.inputs.filter((r) => !byRef.has(r));
  if (missing.length) warnings.push(`couldn't see ${missing.length} of its inputs on the chain; don't sign what you can't check`);
  if (summary.otherRedeemers.length) warnings.push(`it runs scripts other than this vault's: ${summary.otherRedeemers.join(", ")}`);

  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const outs: Out[] = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    outs.push({ address: o.address().to_bech32(), assets: valueToAssets(o.amount()) as Record<string, bigint>, datum: o.datum()?.as_datum()?.to_cbor_hex() });
  }
  const ins = summary.inputs.map((r) => byRef.get(r)).filter((u): u is UTxO => !!u);
  const atVault = (a: string) => a === vault.address;
  const vaultIns = ins.filter((u) => atVault(u.address));
  const vaultOuts = outs.filter((o) => atVault(o.address));
  const isVaultUnit = (u: string) => u.startsWith(vault.hash) && u.length > 56;
  const allowanceUnits = (assets: Record<string, bigint>) => Object.keys(assets).filter((u) => isVaultUnit(u) && u !== vault.configUnit);

  const changes: Change[] = [];
  const cfgIn = vaultIns.find((u) => (u.assets[vault.configUnit] ?? 0n) > 0n);
  const cfgOut = vaultOuts.find((o) => (o.assets[vault.configUnit] ?? 0n) > 0n);
  if (cfgIn || cfgOut)
    changes.push({ kind: "config", before: tryDecode(configFromData, cfgIn?.datum ?? undefined), after: tryDecode(configFromData, cfgOut?.datum) });

  const spendKind = summary.vaultRedeemers.includes("spend:CoSignedSpend")
    ? "CoSignedSpend"
    : summary.vaultRedeemers.includes("spend:AgentSpend")
      ? "AgentSpend"
      : undefined;
  const seen = new Set<string>();
  for (const u of vaultIns)
    for (const unit of allowanceUnits(u.assets as Record<string, bigint>)) {
      seen.add(unit);
      const before = tryDecode(allowanceFromData, u.datum ?? undefined);
      const out = vaultOuts.find((o) => (o.assets[unit] ?? 0n) > 0n);
      if (!out) changes.push({ kind: "revoke", unit, before, lovelace: u.assets.lovelace ?? 0n });
      else if (spendKind) changes.push({ kind: "spend", unit, redeemer: spendKind, before, after: tryDecode(allowanceFromData, out.datum) });
      else
        changes.push({ kind: "edit", unit, before, after: tryDecode(allowanceFromData, out.datum), lovelaceBefore: u.assets.lovelace ?? 0n, lovelaceAfter: out.assets.lovelace ?? 0n });
    }
  for (const o of vaultOuts)
    for (const unit of allowanceUnits(o.assets))
      if (!seen.has(unit)) changes.push({ kind: "grant", unit, after: tryDecode(allowanceFromData, o.datum), lovelace: o.assets.lovelace ?? 0n });

  for (const o of outs)
    if (!atVault(o.address) && Object.keys(o.assets).some(isVaultUnit)) warnings.push(`a vault token leaves the vault, to ${o.address}`);
  for (const c of changes)
    if (("after" in c && c.after === null && c.kind !== "config") || (c.kind === "config" && c.after === null))
      warnings.push(`it writes a ${c.kind === "config" ? "config" : "allowance"} the chain will treat as unreadable`);

  const sum = (xs: { assets: Record<string, bigint> }[]) => xs.reduce((n, x) => n + (x.assets.lovelace ?? 0n), 0n);
  return {
    hash: summary.hash,
    requiredSigners: summary.requiredSigners,
    ...(summary.validity.ttlSlot !== undefined ? { ttlSlot: Number(summary.validity.ttlSlot) } : {}),
    changes,
    leavesVault: sum(vaultIns.map((u) => ({ assets: u.assets as Record<string, bigint> }))) - sum(vaultOuts),
    outside: outs.filter((o) => !atVault(o.address)).map((o) => ({ address: o.address, lovelace: o.assets.lovelace ?? 0n })),
    ...(summary.intent ? { intent: summary.intent } : {}),
    warnings,
  };
}
