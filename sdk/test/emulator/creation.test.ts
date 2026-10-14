// sdk/test/emulator/creation.test.ts
// creationOf must accept exactly a gendo vault creation, and say which vault it makes.
import { beforeAll, describe, expect, it } from "vitest";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { creationOf } from "../../src/core/creation.js";
import { configToData, mintRedeemer } from "../../src/core/data.js";
import * as owner from "../../src/core/owner.js";
import { formatVaultId, makeVault, refHolderAddress } from "../../src/core/vault.js";
import { ADA, emulatorWorld, signAndSubmit } from "../helpers.js";
import { blindEvaluator } from "../yaci/attacker.js"; // builds without running the scripts

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
const init = () => ({ owners: [w.a.pkh, w.b.pkh], threshold: 2n, paused: false, maxTxValidityMs: 600_000n });

beforeAll(async () => {
  w = await emulatorWorld();
  lucid = w.lucid;
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
}, 60_000);

describe("creationOf", () => {
  it("a creation with a reference script and treasury funding: the vault, its id and the funding", async () => {
    const { tx, vault } = await owner.createVault(lucid, init(), { refScriptAddress: refHolderAddress("Custom"), fund: 20n * ADA, signer: w.a.pkh });
    const c = creationOf(tx.toCBOR(), "Custom");
    expect(c.vault.hash).toBe(vault.hash);
    expect(c.config).toEqual(init());
    expect(c.treasuryLovelace).toBe(20n * ADA);
    expect(c.id.seed).toEqual(vault.seed);
    expect(c.id.refScript?.txHash).toBe(tx.toHash());
    // The id names the output that really holds the reference script.
    const ref = tx.toTransaction().body().outputs().get(c.id.refScript!.outputIndex);
    expect(ref.script_ref()?.hash().to_hex()).toBe(vault.hash);
    expect(tx.toTransaction().body().required_signers()?.get(0).to_hex()).toBe(w.a.pkh);
    // And it lands: the vault exists afterwards.
    await signAndSubmit(lucid, w.emulator, tx, [w.a]);
    expect(formatVaultId(c.id)).toMatch(/^gendo:custom:[0-9a-f]{64}#\d+:[0-9a-f]{64}#\d+$/);
  });
  it("a creation without a reference script has a one-part id", async () => {
    const { tx } = await owner.createVault(lucid, init());
    expect(creationOf(tx.toCBOR(), "Custom").id.refScript).toBeUndefined();
  });
  it("refuses a plain payment", async () => {
    const tx = await lucid.newTx().pay.ToAddress(w.b.address, { lovelace: 2n * ADA }).complete();
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/mints exactly one token/);
  });
  it("refuses a config token sent somewhere other than the vault", async () => {
    const seed = (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1)!;
    const vault = makeVault("Custom", { txHash: seed.txHash, outputIndex: seed.outputIndex });
    const tx = await lucid.newTx().collectFrom([seed])
      .mintAssets({ [vault.configUnit]: 1n }, mintRedeemer("InitConfig")).attach.MintingPolicy(vault.script)
      .pay.ToAddressWithData(w.b.address, { kind: "inline", value: configToData(init()) }, { lovelace: 2n * ADA, [vault.configUnit]: 1n })
      .complete({ evaluator: blindEvaluator, setCollateral: 4n * ADA });
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/sends tokens elsewhere/);
  });
  it("refuses an invalid config (threshold above the owner count)", async () => {
    await expect(owner.createVault(lucid, { ...init(), threshold: 3n })).rejects.toThrow(/threshold out of range/);
  });
  it("refuses a reference script parked anywhere but the always-fail holder (someone could spend it)", async () => {
    const { tx } = await owner.createVault(lucid, init(), { refScriptAddress: w.b.address });
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/unexpected reference script/);
  });
});
