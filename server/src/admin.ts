// server/src/admin.ts
// server/gendo-server admin register <policy> --name "Acme payouts" [--listed]
import { parseArgs } from "node:util";
import { openStore } from "./store.js";

const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, listed: { type: "boolean" } } });
const [cmd, policy] = positionals;
if (cmd !== "register" || !policy || !/^[0-9a-f]{56}$/.test(policy) || !v.name) {
  console.error('usage: register <policy id> --name "…" [--listed]');
  process.exit(2);
}
openStore(process.env.DB ?? "gendo.sqlite").put({ policy, name: v.name, listed: !!v.listed });
console.log(JSON.stringify({ registered: policy, name: v.name, listed: !!v.listed }));
