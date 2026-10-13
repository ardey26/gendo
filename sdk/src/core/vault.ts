// Vault identity: the compiled script with its seed parameter applied, plus
// the derived address, policy and token names. Everything here is a pure
// function of (blueprint, seed), so rotating owners can never change it.
import { blake2b } from "@noble/hashes/blake2b";
import {
  Data,
  applyDoubleCborEncoding,
  applyParamsToScript,
  getAddressDetails,
  validatorToAddress,
  validatorToScriptHash,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import blueprint from "../../../onchain/plutus.json" with { type: "json" };
import { fromHex, toHex, utf8ToHex } from "./bytes.js";
import { outRefToData, type Hex } from "./data.js";

export const CONFIG_TOKEN_NAME = utf8ToHex("config");

export type OutRef = { txHash: Hex; outputIndex: number };

export type Vault = {
  network: Network;
  seed: OutRef;
  script: Script;
  hash: Hex; // = spend payment credential = mint policy id
  address: string; // canonical: no stake credential
  configUnit: string;
};

// The compiled validators, bundled with the code (onchain/plutus.json), so the
// same vault identity is derived in Node and in the browser.
function compiled(title: string): string {
  const v = blueprint.validators.find((x: { title: string }) => x.title === title);
  if (!v) throw new Error(`${title} not found in blueprint`);
  return v.compiledCode;
}

export function loadCompiledCode(): string {
  return compiled("vault.vault.spend");
}

/** Refuse mainnet outright (edge I5). This MVP is preprod-only. */
export function assertTestNetwork(network: Network) {
  if (network === "Mainnet") throw new Error("refusing to operate on Mainnet (preprod MVP)");
}

export function makeVault(network: Network, seed: OutRef, compiledCode = loadCompiledCode()): Vault {
  assertTestNetwork(network);
  const script: Script = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(
      applyParamsToScript(compiledCode, [outRefToData(seed.txHash, seed.outputIndex)]),
    ),
  };
  const hash = validatorToScriptHash(script);
  const address = validatorToAddress(network, script); // no stake credential
  const details = getAddressDetails(address);
  if (details.networkId !== 0) throw new Error("vault address is not a testnet address");
  if (details.stakeCredential) throw new Error("vault address must not carry a stake credential");
  return { network, seed, script, hash, address, configUnit: hash + CONFIG_TOKEN_NAME };
}

/** Always-fail address where the vault's reference script is parked (edge I3). */
export function refHolderAddress(network: Network): string {
  return validatorToAddress(network, { type: "PlutusV3", script: applyDoubleCborEncoding(compiled("ref_holder.ref_holder.else")) });
}

/** blake2b_224(cbor(OutputReference)), as `allowance.allowance_name`. */
export function allowanceName(ref: OutRef): Hex {
  const cbor = Data.to(outRefToData(ref.txHash, ref.outputIndex));
  return toHex(blake2b(fromHex(cbor), { dkLen: 28 }));
}

export const blake2b256 = (bytes: Uint8Array): Hex => toHex(blake2b(bytes, { dkLen: 32 }));

/** A vault's one-line id, shared by owners and operators: gendo:<network>:<seed tx>#<i>[:<ref-script tx>#<i>]. */
export type VaultId = { network: Network; seed: OutRef; refScript?: OutRef };

export const formatVaultId = (v: VaultId) =>
  ["gendo", v.network.toLowerCase(), `${v.seed.txHash}#${v.seed.outputIndex}`, ...(v.refScript ? [`${v.refScript.txHash}#${v.refScript.outputIndex}`] : [])].join(":");

export function parseVaultId(id: string): VaultId {
  const ref = (x: string): OutRef => {
    const m = /^([0-9a-f]{64})#(\d{1,5})$/.exec(x);
    if (!m) throw new Error(`bad vault id part ${x}`);
    return { txHash: m[1]!, outputIndex: Number(m[2]) };
  };
  const [tag, net, seed, refScript, ...extra] = id.trim().split(":");
  if (tag !== "gendo" || !net || !seed || extra.length) throw new Error("a vault id looks like gendo:preprod:<tx>#<i>[:<tx>#<i>]");
  const network = ({ preprod: "Preprod", custom: "Custom" } as Record<string, Network>)[net];
  if (!network) throw new Error(`unknown network ${net}`);
  return { network, seed: ref(seed), ...(refScript ? { refScript: ref(refScript) } : {}) };
}
