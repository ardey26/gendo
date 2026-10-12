import { CML, calculateMinLovelaceFromUTxO, type Assets, type LucidEvolution } from "@lucid-evolution/lucid";

export function add(...xs: Assets[]): Assets {
  const out: Assets = {};
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0n) + v;
  return clean(out);
}

export function sub(a: Assets, b: Assets): Assets {
  const neg: Assets = {};
  for (const [k, v] of Object.entries(b)) neg[k] = -v;
  return add(a, neg);
}

export function clean(a: Assets): Assets {
  const out: Assets = {};
  for (const [k, v] of Object.entries(a)) if (v !== 0n) out[k] = v;
  return out;
}

export function hasNegative(a: Assets): boolean {
  return Object.values(a).some((v) => v < 0n);
}

/** Raise lovelace to the ledger minimum for an output at `address` holding `assets`. */
export function withMinAda(lucid: LucidEvolution, address: string, assets: Assets, datum?: string): Assets {
  const pp = lucid.config().protocolParameters!;
  const probe = { txHash: "00".repeat(32), outputIndex: 0, address, assets: { lovelace: 0n, ...assets }, datum: datum ?? null };
  const min = calculateMinLovelaceFromUTxO(pp.coinsPerUtxoByte, probe);
  const lovelace = assets.lovelace ?? 0n;
  return lovelace >= min ? assets : { ...assets, lovelace: min };
}

export const fmt = (a: Assets) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.toString()]));

/** Policy id + raw asset-name hex. Not `to_cbor_hex().slice(2)`: that keeps a length byte for names of 24+ bytes. */
export const unitOfAsset = (policy: CML.ScriptHash, name: CML.AssetName) =>
  policy.to_hex() + Buffer.from(name.to_raw_bytes()).toString("hex");

type AssetMap = {
  keys(): CML.PolicyIdList;
  get_assets(k: CML.ScriptHash): { keys(): CML.AssetNameList; get(k: CML.AssetName): bigint | undefined } | undefined;
};

/** Every asset in a CML multi-asset (or mint) map, keyed by unit. */
export function multiAssetToAssets(ma: AssetMap | undefined): Assets {
  const out: Assets = {};
  if (!ma) return out;
  const pols = ma.keys();
  for (let p = 0; p < pols.len(); p++) {
    const pol = pols.get(p);
    const names = ma.get_assets(pol)!;
    const ks = names.keys();
    for (let n = 0; n < ks.len(); n++) out[unitOfAsset(pol, ks.get(n))] = names.get(ks.get(n))!;
  }
  return out;
}

/** A CML value as `Assets`, lovelace included. */
export const valueToAssets = (v: CML.Value): Assets => ({ lovelace: v.coin(), ...multiAssetToAssets(v.multi_asset()) });
