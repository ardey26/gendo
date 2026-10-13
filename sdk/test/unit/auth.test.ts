// sdk/test/unit/auth.test.ts
import { describe, expect, it } from "vitest";
import { CML, generatePrivateKey } from "@lucid-evolution/lucid";
import { signData } from "@lucid-evolution/sign_data";
import { utf8ToHex } from "../../src/core/bytes.js";
import { cip8Signer } from "../../src/node/auth.js";

const wallet = () => {
  const sk = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const addressHex = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address().to_hex();
  return { sk, pkh, addressHex };
};

describe("cip8Signer", () => {
  const a = wallet();
  const payload = utf8ToHex("gendo sign-in n1");
  it("returns the key hash that signed this payload for this address", () =>
    expect(cip8Signer(a.addressHex, payload, signData(a.addressHex, payload, a.sk))).toBe(a.pkh));
  it("refuses another payload", () =>
    expect(cip8Signer(a.addressHex, utf8ToHex("gendo sign-in n2"), signData(a.addressHex, payload, a.sk))).toBeUndefined());
  it("refuses a key that doesn't own the address", () => {
    const b = wallet();
    expect(cip8Signer(a.addressHex, payload, signData(a.addressHex, payload, b.sk))).toBeUndefined();
  });
});
