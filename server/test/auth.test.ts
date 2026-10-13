// server/test/auth.test.ts
import { describe, expect, it } from "vitest";
import { signData } from "../../sdk/src/node/auth.js";
import { createApp } from "../src/app.js";
import { policy, signIn, store, wallet } from "./helpers.js";

describe("sign-in", () => {
  const a = wallet();
  const mk = (now = () => Date.now()) =>
    createApp({ store: store(), now, upstream: async () => new Response("{}"), owners: async (p) => (p === policy ? [a.pkh] : undefined), allowanceOf: async () => undefined, submit: async () => ({ ok: false, error: "unused" }) });

  it("a wallet that signs the challenge gets a session for its key", async () => {
    const r = await signIn(mk(), a);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ pkh: a.pkh });
  });
  it("a signature over another payload is refused", async () => {
    const app = mk();
    const ch = await (await app.request("/auth/challenge", { method: "POST", body: JSON.stringify({ address: a.addressHex }), headers: { "content-type": "application/json" } })).json();
    const signed = signData(a.addressHex, "00", a.sk);
    expect((await app.request("/auth/verify", { method: "POST", body: JSON.stringify({ nonce: ch.nonce, ...signed }), headers: { "content-type": "application/json" } })).status).toBe(401);
  });
  it("a challenge works once", async () => {
    const app = mk();
    const ch = await (await app.request("/auth/challenge", { method: "POST", body: JSON.stringify({ address: a.addressHex }), headers: { "content-type": "application/json" } })).json();
    const body = JSON.stringify({ nonce: ch.nonce, ...signData(a.addressHex, ch.payload, a.sk) });
    expect((await app.request("/auth/verify", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(200);
    expect((await app.request("/auth/verify", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(401);
  });
  it("owner endpoints: 401 without a session or after it expires, 403 for a non-owner", async () => {
    let t = Date.now();
    const app = mk(() => t);
    expect((await app.request(`/vaults/${policy}/pending`)).status).toBe(401);
    const { token } = await (await signIn(app, a)).json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.request(`/vaults/${policy}/pending`, { headers: auth })).status).toBe(200);
    expect((await app.request(`/vaults/${"cd".repeat(28)}/pending`, { headers: auth })).status).toBe(403);
    t += 13 * 3_600_000;
    expect((await app.request(`/vaults/${policy}/pending`, { headers: auth })).status).toBe(401);
  });
});
