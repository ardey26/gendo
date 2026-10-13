// server/src/app.ts
// The keyless server. It can delay or withhold reads (liveness); it holds no
// wallet key, so it can never move funds (custody stays with owners' wallets).
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { mountAuth } from "./auth.js";
import { mountPending, type SubmitResult } from "./pending.js";
import type { openStore } from "./store.js";

// What the public page and the owner pages read. Never submit, accounts or pools: owners' txs
// reach the chain only through the inbox, after every required signer has signed.
const ALLOWED = [
  /^\/genesis$/,
  /^\/epochs\/latest\/parameters$/,
  /^\/blocks\/latest$/,
  /^\/addresses\/addr_test1[02-9ac-hj-np-z]{50,110}\/utxos(\/[0-9a-f]{56,120})?$/,
  /^\/assets\/[0-9a-f]{56,120}\/addresses$/,
  /^\/scripts\/[0-9a-f]{56}(\/cbor)?$/,
  /^\/scripts\/datum\/[0-9a-f]{64}\/cbor$/,
  /^\/txs\/[0-9a-f]{64}(\/utxos|\/metadata|\/redeemers|\/cbor)?$/,
];
const QUERY: Record<string, RegExp> = { page: /^([1-9]|1\d|20)$/, count: /^([1-9]\d?|100)$/, order: /^(asc|desc)$/ };
const MAX_CACHE = 5_000;
const MAX_CACHED_BODY = 256_000;
const MAX_CACHE_BYTES = 64_000_000;

const remoteIp = (c: Context) => {
  try {
    return getConnInfo(c).remote.address ?? "?";
  } catch {
    return "?";
  }
};

export function createApp(d: {
  upstream: (pathAndQuery: string) => Promise<Response>;
  store: ReturnType<typeof openStore>;
  now?: () => number;
  /** Requests per client per minute (the Blockfrost quota is shared by everyone). */
  perMinute?: number;
  clientIp?: (c: Context) => string;
  /** The vault's owner key hashes from its on-chain config, or undefined when there's no vault. */
  owners: (policy: string) => Promise<string[] | undefined>;
  /** Broadcast a fully signed tx; `transient` marks errors worth retrying (network, 429, 5xx). */
  submit: (txCbor: string) => Promise<SubmitResult>;
  /** An allowance's current UTxO and agent key, from the chain. */
  allowanceOf: (policy: string, unit: string) => Promise<{ ref: string; agent: string } | undefined>;
  /** The network vault ids must be on ("Preprod" or "Custom"). */
  network?: string;
  maxOpenPerVault?: number;
  maxOpenPerKey?: number;
}) {
  const now = d.now ?? Date.now;
  const perMinute = d.perMinute ?? 600;
  const clientIp = d.clientIp ?? remoteIp;
  const cache = new Map<string, { at: number; status: number; body: string }>();
  let cacheBytes = 0;
  const hits = new Map<string, { minute: number; n: number }>();
  const app = new Hono();
  app.onError((e, c) => (e instanceof SyntaxError ? c.json({ error: "malformed JSON" }, 400) : c.json({ error: "server error" }, 500)));
  // Everything but the chain proxy (which has its own bucket): sign-in, inbox, requests.
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/chain/") || c.req.method === "GET" && !/^\/(me|vaults|pending)\//.test(c.req.path)) return next();
    if (limited(`api:${clientIp(c)}`)) return c.json({ error: "too many requests" }, 429);
    return next();
  });
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
  const auth = mountAuth(app, { store: d.store, now, owners: d.owners });
  mountPending(
    app,
    {
      store: d.store, now, owners: d.owners, submit: d.submit, upstream: d.upstream, allowanceOf: d.allowanceOf, network: d.network,
      maxOpenPerVault: d.maxOpenPerVault ?? 50, maxOpenPerKey: d.maxOpenPerKey ?? 20,
    },
    auth,
  );

  function limited(ip: string) {
    const minute = Math.floor(now() / 60_000);
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
    const h = hits.get(ip);
    if (!h || h.minute !== minute) return hits.set(ip, { minute, n: 1 }), false;
    return ++h.n > perMinute;
  }
  const fetchWithRetry = async (key: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await d.upstream(key);
        if (res.status < 500 || attempt === 1) return res;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
  };

  app.get("/chain/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/chain".length);
    if (!ALLOWED.some((r) => r.test(path))) return c.json({ error: "not allowed" }, 404);
    if (limited(clientIp(c))) return c.json({ error: "too many requests" }, 429);
    const q = new URLSearchParams();
    for (const [k, ok] of Object.entries(QUERY)) {
      const v = url.searchParams.get(k);
      if (v === null) continue;
      if (!ok.test(v)) return c.json({ error: `bad ${k}` }, 400);
      q.set(k, v);
    }
    const key = q.size ? `${path}?${q}` : path;
    const hit = cache.get(key);
    const ttl = (status: number) => (path.startsWith("/txs/") && status === 200 ? 3_600_000 : 10_000);
    // A signed-in owner's app sends its session token as project_id (Lucid's Blockfrost client sets
    // that header): it builds txs on the current state, so it skips the cache. Everyone else, the
    // public page included, gets cached answers, so nobody can burn the shared quota by asking.
    const fresh = !!auth.pkhOfToken(c.req.header("project_id"));
    if (hit && !fresh && now() - hit.at < ttl(hit.status)) return c.body(hit.body, hit.status as 200, { "content-type": "application/json" });
    let res: Response;
    try {
      res = await fetchWithRetry(key);
    } catch {
      return c.json({ error: "chain unavailable" }, 502);
    }
    if (res.status >= 500 || res.status === 429 || res.status === 403) return c.json({ error: "chain unavailable" }, 502);
    const body = await res.text();
    if ((res.status === 200 || res.status === 404) && body.length <= MAX_CACHED_BODY) {
      const old = cache.get(key);
      if (old) cacheBytes -= old.body.length, cache.delete(key);
      while (cache.size && (cache.size >= MAX_CACHE || cacheBytes + body.length > MAX_CACHE_BYTES)) {
        const [k, v] = cache.entries().next().value!;
        cacheBytes -= v.body.length;
        cache.delete(k);
      }
      cache.set(key, { at: now(), status: res.status, body });
      cacheBytes += body.length;
    }
    return c.body(body, res.status as 200, { "content-type": "application/json" });
  });

  app.get("/public/:policy", (c) => {
    const policy = c.req.param("policy");
    if (!/^[0-9a-f]{56}$/.test(policy)) return c.json({ error: "bad vault id" }, 400);
    const l = d.store.get(policy);
    return l ? c.json({ ...l, agents: d.store.labelsOf(policy) }) : c.json({ error: "unknown vault" }, 404);
  });

  return app;
}
