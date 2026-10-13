// server/test/owner-client.ts — an owner's browser, minus the browser: signs in with a key
// file (CIP-8) and talks to the inbox. Usage (SERVER env, TOKEN env after auth):
//   auth <key.sk> → prints a token
//   propose <policy> <tx.cbor> <witness> <title> → prints the pending row
//   sign <id> <witness> → prints the pending row
//   list <policy> → prints the rows
//   token <policy> <unit> → prints a fresh agent token
import { readFileSync } from "node:fs";
import { CML } from "../../sdk/src/core/index.js";
import { signData } from "../../sdk/src/node/auth.js";

const [cmd, ...a] = process.argv.slice(2);
const server = process.env.SERVER ?? "http://localhost:8797";
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(server + path, {
    method,
    headers: { "content-type": "application/json", ...(process.env.TOKEN ? { authorization: `Bearer ${process.env.TOKEN}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};
const file = (p: string) => readFileSync(p, "utf8").trim();

if (cmd === "auth") {
  const sk = file(a[0]!);
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const addressHex = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address().to_hex();
  const ch = await call("POST", "/auth/challenge", { address: addressHex });
  console.log((await call("POST", "/auth/verify", { nonce: ch.nonce, ...signData(addressHex, ch.payload, sk) })).token);
} else if (cmd === "propose") console.log(JSON.stringify(await call("POST", `/vaults/${a[0]}/pending`, { cbor: file(a[1]!), witness: file(a[2]!), title: a[3] })));
else if (cmd === "sign") console.log(JSON.stringify(await call("POST", `/pending/${a[0]}/witness`, { witness: file(a[1]!) })));
else if (cmd === "list") console.log(JSON.stringify(await call("GET", `/vaults/${a[0]}/pending`)));
else if (cmd === "token") console.log((await call("POST", `/vaults/${a[0]}/agents/${a[1]}/token`, {})).token);
else throw new Error("usage: auth|propose|sign|list|token");
