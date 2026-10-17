import { describe, expect, it } from "vitest";
import { CML, generatePrivateKey } from "@lucid-evolution/lucid";
import { confirmWords, pairingMessage, signMessage, statusMessage, verifyMessage } from "../../src/core/pairing.js";

const pkhOf = (sk: string) => CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();

describe("pairing", () => {
  it("confirm words are the same for a key and differ across keys", () => {
    const a = pkhOf(generatePrivateKey()), b = pkhOf(generatePrivateKey());
    expect(confirmWords(a)).toBe(confirmWords(a));
    expect(confirmWords(a)).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    expect(confirmWords(a)).not.toBe(confirmWords(b));
  });
  it("a signed message verifies to the signer's key hash; anything else doesn't", () => {
    const sk = generatePrivateKey();
    const s = signMessage(sk, pairingMessage("GENDO-7K3F-Q9"));
    expect(verifyMessage(s.publicKey, pairingMessage("GENDO-7K3F-Q9"), s.signature)).toBe(pkhOf(sk));
    expect(verifyMessage(s.publicKey, pairingMessage("GENDO-7K3F-QX"), s.signature)).toBeUndefined();
    expect(verifyMessage(s.publicKey, statusMessage(1), s.signature)).toBeUndefined();
    expect(verifyMessage("zz", "x", "zz")).toBeUndefined();
  });
});
