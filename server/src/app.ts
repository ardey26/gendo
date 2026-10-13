// server/src/app.ts
// The keyless server. It can delay or withhold reads (liveness); it holds no
// wallet key, so it can never move funds (custody stays with owners' wallets).
import { Hono } from "hono";
import type { openStore } from "./store.js";

const ALLOWED = [
  /^\/addresses\/addr_test1[0-9a-z]{20,120}\/utxos$/,
  /^\/txs\/[0-9a-f]{64}(\/utxos|\/metadata)?$/,
  /^\/blocks\/latest$/,
];
const SAFE_QUERY = ["page", "count", "order"];
const MAX_CACHE = 5_000;

export function createApp(d: {
  upstream: (pathAndQuery: string) => Promise<Response>;
  store: ReturnType<typeof openStore>;
  now?: () => number;
}) {
  const now = d.now ?? Date.now;
  const cache = new Map<string, { at: number; status: number; body: string }>();
  const app = new Hono();

  app.get("/chain/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/chain".length);
    if (!ALLOWED.some((r) => r.test(path))) return c.json({ error: "not allowed" }, 404);
    const q = new URLSearchParams();
    for (const k of SAFE_QUERY) {
      const v = url.searchParams.get(k);
      if (v !== null && /^[a-z0-9]{1,8}$/.test(v)) q.set(k, v);
    }
    const key = q.size ? `${path}?${q}` : path;
    const hit = cache.get(key);
    const ttl = (status: number) => (path.startsWith("/txs/") && status === 200 ? 3_600_000 : 10_000);
    if (hit && now() - hit.at < ttl(hit.status)) return c.body(hit.body, hit.status as 200, { "content-type": "application/json" });
    let res: Response;
    try {
      res = await d.upstream(key);
    } catch {
      return c.json({ error: "chain unavailable" }, 502);
    }
    if (res.status >= 500 || res.status === 429 || res.status === 403) return c.json({ error: "chain unavailable" }, 502);
    const body = await res.text();
    if (res.status === 200 || res.status === 404) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: now(), status: res.status, body });
    }
    return c.body(body, res.status as 200, { "content-type": "application/json" });
  });

  app.get("/public/:policy", (c) => {
    const policy = c.req.param("policy");
    if (!/^[0-9a-f]{56}$/.test(policy)) return c.json({ error: "bad vault id" }, 400);
    const l = d.store.get(policy);
    return l ? c.json(l) : c.json({ error: "unknown vault" }, 404);
  });

  return app;
}
