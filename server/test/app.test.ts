// server/test/app.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientIpFrom, createApp } from "../src/app.js";
import { openStore } from "../src/store.js";
import { signIn, wallet } from "./helpers.js";

const store = () => openStore(join(mkdtempSync(join(tmpdir(), "gendo-srv-")), "db.sqlite"));
const policy = "ab".repeat(28);

describe("chain proxy", () => {
  it("forwards allowlisted reads with only safe query params", async () => {
    const seen: string[] = [];
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async (p) => (seen.push(p), new Response('[{"ok":1}]', { status: 200 })) });
    const r = await app.request("/chain/addresses/addr_test1wq2hzkq0f6n5lkuw8zs0hfeuu85aeadmnfs0rywqs7aghssrt0340/utxos?page=2&count=100&evil=1");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ ok: 1 }]);
    expect(seen).toEqual(["/addresses/addr_test1wq2hzkq0f6n5lkuw8zs0hfeuu85aeadmnfs0rywqs7aghssrt0340/utxos?page=2&count=100"]);
  });
  it("refuses anything not on the allowlist, including submit", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => new Response("{}") });
    for (const p of ["/chain/tx/submit", "/chain/accounts/stake1x", "/chain/txs/zz/utxos", "/chain/../admin"])
      expect((await app.request(p)).status).toBe(404);
    expect((await app.request("/chain/txs/" + "a".repeat(64) + "/utxos", { method: "POST" })).status).toBe(404);
  });
  it("answers 502 when the chain is down, without leaking anything", async () => {
    const down = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => { throw new Error("project_id preprodSECRET timed out"); } });
    const r = await down.request("/chain/blocks/latest");
    expect(r.status).toBe(502);
    expect(await r.text()).not.toMatch(/SECRET|project_id/);
    const five = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => new Response("bad", { status: 503 }) });
    expect((await five.request("/chain/blocks/latest")).status).toBe(502);
  });
  it("caches immutable tx reads for an hour and live reads for 10 s", async () => {
    let t = 0;
    let calls = 0;
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), now: () => t, upstream: async () => (calls++, new Response("{}", { status: 200 })) });
    const tx = "/chain/txs/" + "c".repeat(64);
    await app.request(tx); t += 30 * 60_000; await app.request(tx);
    expect(calls).toBe(1);
    await app.request("/chain/blocks/latest"); t += 11_000; await app.request("/chain/blocks/latest");
    expect(calls).toBe(3);
  });
  it("re-checks a tx that wasn't found yet after 10 s", async () => {
    let t = 0;
    let calls = 0;
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), now: () => t, upstream: async () => (calls++, new Response("{}", { status: 404 })) });
    const tx = "/chain/txs/" + "d".repeat(64);
    await app.request(tx); t += 11_000; await app.request(tx);
    expect(calls).toBe(2);
  });
});

describe("chain proxy limits", () => {
  const ok = async () => new Response("[]", { status: 200 });
  const script = "addr_test1wrkxfunr68mzu72j9v44sukw8k35awymwk6v2ghudau3rnca6a4lh";
  it("reads any testnet address's UTxOs (owners' wallets too)", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok });
    expect((await app.request(`/chain/addresses/${script}/utxos`)).status).toBe(200);
    expect((await app.request("/chain/addresses/addr_test1vq9jmx22305ltuwma9kmz2vcgde7rvydaynfxwqvfrypp9c97slgs/utxos")).status).toBe(200);
  });
  it("allows the redeemer reads the history needs", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok });
    expect((await app.request("/chain/txs/" + "a".repeat(64) + "/redeemers")).status).toBe(200);
    expect((await app.request("/chain/scripts/datum/" + "b".repeat(64) + "/cbor")).status).toBe(200);
  });
  it("refuses paging outside page 1..20, count 1..100, order asc|desc", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok });
    for (const q of ["page=21", "page=0", "count=101", "count=abc", "order=random"])
      expect((await app.request(`/chain/addresses/${script}/utxos?${q}`)).status).toBe(400);
    expect((await app.request(`/chain/addresses/${script}/utxos?page=20&count=100&order=desc`)).status).toBe(200);
  });
  it("doesn't cache a large response", async () => {
    let calls = 0;
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => (calls++, new Response("x".repeat(300_000), { status: 200 })) });
    await app.request("/chain/txs/" + "e".repeat(64)); await app.request("/chain/txs/" + "e".repeat(64));
    expect(calls).toBe(2);
  });
  it("rate-limits each client", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok, perMinute: 3, clientIp: (c) => c.req.header("x-ip") ?? "?" });
    const hit = (ip: string) => app.request("/chain/blocks/latest", { headers: { "x-ip": ip } });
    for (let i = 0; i < 3; i++) expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(200);
  });
  it("behind a proxy, rate-limits by the header the proxy sets", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok, perMinute: 2, clientIp: clientIpFrom("true-client-ip") });
    const hit = (ip?: string) => app.request("/chain/blocks/latest", { headers: ip ? { "true-client-ip": ip, "x-forwarded-for": "9.9.9.9" } : {} });
    for (let i = 0; i < 2; i++) expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(200);
    expect((await hit()).status).toBe(200); // no header: falls back to the connection's address
  });
  it("retries a failed read once", async () => {
    let calls = 0;
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response("{}", { status: 200 })) });
    expect((await app.request("/chain/blocks/latest")).status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("public listing", () => {
  it("returns a registered vault's name and listed flag", async () => {
    const s = store();
    s.put({ policy, name: "Acme payouts", listed: true });
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: s, upstream: async () => new Response("{}") });
    expect(await (await app.request(`/public/${policy}`)).json()).toEqual({ policy, name: "Acme payouts", listed: true, agents: {} });
  });
  it("an unnamed vault's agent names still come back", async () => {
    const s = store();
    s.putLabel(policy, policy + "01", "My Claude");
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: s, upstream: async () => new Response("{}") });
    expect(await (await app.request(`/public/${policy}`)).json()).toEqual({ policy, name: null, listed: false, agents: { [policy + "01"]: "My Claude" } });
  });
  it("404 for unknown, 400 for a malformed id", async () => {
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => new Response("{}") });
    expect((await app.request(`/public/${policy}`)).status).toBe(404);
    expect((await app.request("/public/not-a-policy")).status).toBe(400);
  });
});

describe("chain proxy for the owner pages", () => {
  const ok = async (p: string) => new Response(JSON.stringify({ p }), { status: 200 });
  const mk = () => createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: ok });
  it("forwards what Lucid needs to build owner txs", async () => {
    const app = mk();
    for (const p of [
      "/genesis",
      "/epochs/latest/parameters",
      "/addresses/addr_test1vq9jmx22305ltuwma9kmz2vcgde7rvydaynfxwqvfrypp9c97slgs/utxos?page=1",
      `/addresses/addr_test1wrkxfunr68mzu72j9v44sukw8k35awymwk6v2ghudau3rnca6a4lh/utxos/${"ab".repeat(28)}11`,
      `/assets/${"ab".repeat(28)}11/addresses?count=2`,
      `/scripts/${"ab".repeat(28)}/cbor`,
      `/txs/${"c".repeat(64)}/cbor`,
    ])
      expect((await app.request(`/chain${p}`)).status, p).toBe(200);
  });
  it("still refuses submit, accounts and anything unlisted", async () => {
    const app = mk();
    for (const p of ["/tx/submit", "/accounts/stake_test1uq", "/addresses/stake_test1uq/utxos", "/network"]) expect((await app.request(`/chain${p}`)).status, p).toBe(404);
  });
});

describe("fresh reads for owners", () => {
  it("only a signed-in owner's session skips the cache; anyone else gets the cached answer", async () => {
    let calls = 0;
    const app = createApp({ owners: async () => undefined, allowanceOf: async () => undefined, submit: async () => ({ ok: false as const, error: "unused" }), store: store(), upstream: async () => (calls++, new Response("[]", { status: 200 })) });
    const path = "/chain/addresses/addr_test1vq9jmx22305ltuwma9kmz2vcgde7rvydaynfxwqvfrypp9c97slgs/utxos";
    await app.request(path);
    await app.request(path, { headers: { project_id: "no-cache" } });
    await app.request(path, { headers: { project_id: "f".repeat(64) } });
    expect(calls).toBe(1);
    const { token } = await (await signIn(app, wallet())).json();
    await app.request(path, { headers: { project_id: token } });
    expect(calls).toBe(2);
  });
});
