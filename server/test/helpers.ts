// server/test/helpers.ts — shared by the server tests (a test file must not import another test file:
// vitest would register its tests twice).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CML, generatePrivateKey, makeVault } from "../../sdk/src/core/index.js";
import { signData } from "../../sdk/src/node/auth.js";
import type { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

export const wallet = () => {
  const sk = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const addressHex = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address().to_hex();
  return { sk, pkh, addressHex };
};
/** A real vault id (no chain needed): the tests' vault policy is derived from it, as the server does. */
export const vaultId = `gendo:custom:${"ee".repeat(32)}#0`;
export const vault = makeVault("Custom", { txHash: "ee".repeat(32), outputIndex: 0 });
export const policy = vault.hash;
export const store = () => openStore(join(mkdtempSync(join(tmpdir(), "gendo-auth-")), "db.sqlite"));
export async function signIn(app: ReturnType<typeof createApp>, w: ReturnType<typeof wallet>) {
  const ch = await (await app.request("/auth/challenge", { method: "POST", body: JSON.stringify({ address: w.addressHex }), headers: { "content-type": "application/json" } })).json();
  const signed = signData(w.addressHex, ch.payload, w.sk);
  return app.request("/auth/verify", { method: "POST", body: JSON.stringify({ nonce: ch.nonce, ...signed }), headers: { "content-type": "application/json" } });
}
export const json = (headers: Record<string, string> = {}) => ({ ...headers, "content-type": "application/json" });
