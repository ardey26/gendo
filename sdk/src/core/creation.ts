// sdk/src/core/creation.ts
// Is this tx exactly a gendo vault creation, and which vault does it make? Used by the app's
// server before it submits and registers a vault on an owner's behalf.
import { CML, type Network } from "@lucid-evolution/lucid";
import { multiAssetToAssets, valueToAssets } from "./assets.js";
import { configFromData, type ConfigDatum } from "./data.js";
import { isValidConfig } from "./limits.js";
import { CONFIG_TOKEN_NAME, makeVault, refHolderAddress, type Vault, type VaultId } from "./vault.js";

export type Creation = { vault: Vault; config: ConfigDatum; id: VaultId; treasuryLovelace: bigint };

/** Each input costs a script derivation to check (~14 ms): a creation needs a few, never this many. */
const MAX_INPUTS = 50;

export function creationOf(txCbor: string, network: Network): Creation {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const hash = CML.hash_transaction(body).to_hex();
  const minted = Object.entries(multiAssetToAssets(body.mint()));
  if (minted.length !== 1 || minted[0]![1] !== 1n || minted[0]![0].slice(56) !== CONFIG_TOKEN_NAME)
    throw new Error("a vault creation mints exactly one token, the config token");
  const policy = minted[0]![0].slice(0, 56);
  if (body.inputs().len() > MAX_INPUTS) throw new Error(`too many inputs for a vault creation (${body.inputs().len()})`);
  let vault: Vault | undefined;
  for (let i = 0; i < body.inputs().len() && !vault; i++) {
    const inp = body.inputs().get(i);
    const v = makeVault(network, { txHash: inp.transaction_id().to_hex(), outputIndex: Number(inp.index()) });
    if (v.hash === policy) vault = v;
  }
  if (!vault) throw new Error("the tx doesn't spend this vault's seed");
  if (body.withdrawals() || body.certs() || body.voting_procedures() || body.proposal_procedures())
    throw new Error("a vault creation may not withdraw, certify or vote");
  const holder = refHolderAddress(network);
  let config: ConfigDatum | undefined;
  let refIndex: number | undefined;
  let treasury = 0n;
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    const address = o.address().to_bech32();
    const assets = valueToAssets(o.amount()) as Record<string, bigint>;
    const units = Object.keys(assets).filter((u) => u !== "lovelace");
    if (address === vault.address) {
      if (!config && units.length === 1 && units[0] === vault.configUnit && assets[vault.configUnit] === 1n) {
        const datum = o.datum()?.as_datum()?.to_cbor_hex();
        if (!datum) throw new Error("the config has no inline datum");
        config = configFromData(datum);
        const problems = isValidConfig(config);
        if (problems.length) throw new Error(`invalid config: ${problems.join("; ")}`);
      } else if (units.length === 0 && !o.datum() && !o.script_ref()) treasury += assets.lovelace ?? 0n;
      else throw new Error("an unexpected output at the vault");
    } else {
      // The creator's own tokens may come back as change; the vault's token may not leave.
      if (units.some((u) => u.startsWith(vault.hash))) throw new Error("the vault's token leaves the vault");
      if (o.script_ref()) {
        if (address !== holder || o.script_ref()!.hash().to_hex() !== vault.hash || refIndex !== undefined)
          throw new Error("an unexpected reference script");
        refIndex = i;
      }
    }
  }
  if (!config) throw new Error("no config at the vault");
  return {
    vault, config, treasuryLovelace: treasury,
    id: { network, seed: vault.seed, ...(refIndex === undefined ? {} : { refScript: { txHash: hash, outputIndex: refIndex } }) },
  };
}
