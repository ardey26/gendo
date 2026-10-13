// sdk/test/emulator/witnesses.test.ts
import { describe, expect, it } from "vitest";
import { witness } from "../../src/core/cosign.js";
import { bodyHash, requiredSignersOf, verifiedSigners, withWitnesses } from "../../src/core/witnesses.js";
import { ADA, emulatorWorld } from "../helpers.js";

describe("witnesses", async () => {
  const w = await emulatorWorld();
  w.lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const tx = await w.lucid.newTx().pay.ToAddress(w.payee.address, { lovelace: 3n * ADA }).addSignerKey(w.b.pkh).complete();
  const cbor = tx.toCBOR();
  const other = (await w.lucid.newTx().pay.ToAddress(w.payee.address, { lovelace: 4n * ADA }).complete()).toCBOR();

  it("reads the body hash and the required signers", () => {
    expect(bodyHash(cbor)).toBe(tx.toHash());
    expect(requiredSignersOf(cbor)).toEqual([w.b.pkh]);
  });
  it("returns who signed this exact body", async () => {
    expect(verifiedSigners(cbor, await witness(w.lucid, cbor, w.b.privateKey))).toEqual([w.b.pkh]);
  });
  it("refuses a witness made for another tx", async () => {
    const wrong = await witness(w.lucid, other, w.b.privateKey);
    expect(() => verifiedSigners(cbor, wrong)).toThrow(/doesn't match/);
  });
  it("merges witnesses without touching the body, and the node accepts it", async () => {
    const signed = withWitnesses(cbor, [await witness(w.lucid, cbor, w.a.privateKey), await witness(w.lucid, cbor, w.b.privateKey)]);
    expect(bodyHash(signed)).toBe(tx.toHash());
    expect(await w.lucid.wallet().submitTx(signed)).toBe(tx.toHash());
  });
});
