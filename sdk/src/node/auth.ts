// sdk/src/node/auth.ts
// Sign-in for owners: a CIP-30 wallet signs a server challenge (CIP-8); this returns the
// payment key hash that signed it, which the server then looks for in the vault's owners.
import { CML } from "@lucid-evolution/lucid";
import { verifyData } from "@lucid-evolution/sign_data";
// Re-exported for tools and tests outside sdk/ that sign in as an owner with a key file.
export { signData } from "@lucid-evolution/sign_data";
import { fromHex } from "../core/bytes.js";

export function cip8Signer(addressHex: string, payloadHex: string, signed: { signature: string; key: string }): string | undefined {
  try {
    const pkh = CML.Address.from_raw_bytes(fromHex(addressHex)).payment_cred()?.as_pub_key()?.to_hex();
    return pkh && verifyData(addressHex, pkh, payloadHex, signed) ? pkh : undefined;
  } catch {
    return undefined;
  }
}
