// server/src/main.ts
// Run: BLOCKFROST_URL=… BLOCKFROST_PROJECT_ID=… [VAULT_NETWORK=Preprod|Custom] [DB=…] [STATIC_DIR=../app/dist] [PORT=8787] server/gendo-server
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ogmiosCostModels } from "../../sdk/src/core/provider.js";
import { readVault, type Get } from "../../sdk/src/read/index.js";
import { createApp } from "./app.js";
import { openStore } from "./store.js";

const url = process.env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
const key = process.env.BLOCKFROST_PROJECT_ID ?? "";
if (/mainnet/i.test(url) || key.startsWith("mainnet")) throw new Error("preprod only");
const network = (process.env.VAULT_NETWORK ?? "Preprod") as "Preprod" | "Custom";
if (network !== "Preprod" && network !== "Custom") throw new Error("VAULT_NETWORK must be Preprod or Custom");
const upstream = (p: string) => fetch(url + p, { headers: { project_id: key }, signal: AbortSignal.timeout(15_000) });
// The devnet's indexer (Yaci Store) has no /genesis and may omit raw cost models: answer
// them the way Blockfrost does on preprod, from the devnet's admin API and Ogmios.
const devnet = network === "Custom" ? { admin: process.env.YACI_ADMIN ?? "http://localhost:10000/local-cluster/api", ogmios: process.env.YACI_OGMIOS ?? "ws://localhost:1337" } : undefined;
const chain = async (p: string): Promise<Response> => {
  if (devnet && p === "/genesis") {
    const d = (await (await fetch(`${devnet.admin}/admin/devnet`)).json()) as { startTime: number; slotLength: number };
    return Response.json({ network_magic: 42, system_start: d.startTime, slot_length: d.slotLength });
  }
  const r = await upstream(p);
  if (devnet && p === "/epochs/latest/parameters" && r.ok) {
    const body = (await r.json()) as Record<string, unknown>;
    if (!body.cost_models_raw) body.cost_models_raw = await ogmiosCostModels(devnet.ogmios);
    return Response.json(body);
  }
  return r;
};
const get: Get = async (p) => {
  const r = await upstream(p);
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`chain ${r.status}`);
  return r.json();
};
// Owner lists change only through a threshold-signed config tx: a short cache saves Blockfrost calls.
const ownerCache = new Map<string, { at: number; owners: string[] | undefined }>();
const owners = async (policy: string) => {
  const hit = ownerCache.get(policy);
  if (hit && Date.now() - hit.at < 30_000) return hit.owners;
  const found = (await readVault(get, policy, network, Date.now()))?.config?.owners;
  if (ownerCache.size >= 1_000) ownerCache.delete(ownerCache.keys().next().value!); // bounded: random ids can't grow it
  ownerCache.set(policy, { at: Date.now(), owners: found });
  return found;
};
const allowanceOf = async (policy: string, unit: string) => {
  const a = (await readVault(get, policy, network, Date.now()))?.allowances.find((x) => x.unit === unit);
  return a?.agent ? { ref: `${a.txHash}#${a.outputIndex}`, agent: a.agent } : undefined;
};
const submit = async (cbor: string) => {
  try {
    const r = await fetch(`${url}/tx/submit`, {
      method: "POST",
      headers: { project_id: key, "content-type": "application/cbor" },
      body: Buffer.from(cbor, "hex"),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (r.ok) return { ok: true as const, hash: text.replace(/"/g, "").trim() };
    return { ok: false as const, error: text.slice(0, 500), transient: r.status === 429 || r.status >= 500 };
  } catch (e) {
    return { ok: false as const, error: `couldn't reach the chain: ${(e as Error).message}`, transient: true };
  }
};
const app = createApp({ store: openStore(process.env.DB ?? "gendo.sqlite"), upstream: chain, owners, allowanceOf, submit, network });
const dir = resolve(process.env.STATIC_DIR ?? "../app/dist");
app.use("/assets/*", serveStatic({ root: relative(process.cwd(), dir) }));
const index = () => readFileSync(join(dir, "index.html"), "utf8");
app.get("*", (c) => c.html(index())); // the app routes /w/… itself
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
console.error(`gendo server on :${process.env.PORT ?? 8787}, static ${dir}`);
