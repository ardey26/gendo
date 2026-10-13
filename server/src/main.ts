// server/src/main.ts
// Run: BLOCKFROST_URL=… BLOCKFROST_PROJECT_ID=… [DB=…] [STATIC_DIR=../app/dist] [PORT=8787] server/gendo-server
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createApp } from "./app.js";
import { openStore } from "./store.js";

const url = process.env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
const key = process.env.BLOCKFROST_PROJECT_ID ?? "";
if (/mainnet/i.test(url) || key.startsWith("mainnet")) throw new Error("preprod only");
const app = createApp({
  store: openStore(process.env.DB ?? "gendo.sqlite"),
  upstream: (p) => fetch(url + p, { headers: { project_id: key }, signal: AbortSignal.timeout(15_000) }),
});
const dir = resolve(process.env.STATIC_DIR ?? "../app/dist");
app.use("/assets/*", serveStatic({ root: relative(process.cwd(), dir) }));
const index = () => readFileSync(join(dir, "index.html"), "utf8");
app.get("*", (c) => c.html(index())); // the app routes /w/… itself
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
console.error(`gendo server on :${process.env.PORT ?? 8787}, static ${dir}`);
