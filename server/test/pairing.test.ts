// server/test/pairing.test.ts
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { confirmWords, pairingMessage, signMessage } from "../../sdk/src/core/pairing.js";
import { createApp } from "../src/app.js";
import { json, policy, signIn, store, wallet } from "./helpers.js";

async function setup(now = () => Date.now()) {
  const A = wallet(), X = wallet();
  const app = createApp({ store: store(), now, upstream: async () => new Response("{}", { status: 404 }), owners: async (p) => (p === policy ? [A.pkh] : undefined), allowanceOf: async () => undefined, submit: async () => ({ ok: true as const, hash: "h" }) });
  const tok = async (w: typeof A) => ((await (await signIn(app, w)).json()) as { token: string }).token;
  const call = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: json(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { app, A, X, tok, call };
}
const claimBody = (code: string, sk = generatePrivateKey()) => ({ code, ...signMessage(sk, pairingMessage(code)) });

describe("pairings", () => {
  it("an owner makes a code; the agent claims it with its key; the owner sees the words and confirms", async () => {
    const s = await setup();
    const a = await s.tok(s.A);
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, a, { name: "My Claude" })).json()) as { id: string; code: string };
    expect(p.code).toMatch(/^GENDO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const sk = generatePrivateKey();
    const c = (await (await s.call("POST", "/pairings/claim", undefined, claimBody(p.code, sk))).json()) as { words: string };
    const view = (await (await s.call("GET", `/pairings/${p.id}`, a)).json()) as { status: string; words: string; agent: string };
    expect(view).toMatchObject({ status: "claimed", words: c.words });
    expect(c.words).toBe(confirmWords(view.agent));
    expect((await (await s.call("POST", `/pairings/${p.id}/confirm`, a)).json())).toMatchObject({ status: "confirmed" });
  });
  it("a code works once", async () => {
    const s = await setup();
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, await s.tok(s.A), { name: "x" })).json()) as { code: string };
    expect((await s.call("POST", "/pairings/claim", undefined, claimBody(p.code))).status).toBe(200);
    expect((await s.call("POST", "/pairings/claim", undefined, claimBody(p.code))).status).toBe(409);
  });
  it("a code expires after 15 minutes", async () => {
    let t = 1_000_000_000;
    const s = await setup(() => t);
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, await s.tok(s.A), { name: "x" })).json()) as { code: string };
    t += 15 * 60_000 + 1;
    expect((await s.call("POST", "/pairings/claim", undefined, claimBody(p.code))).status).toBe(404);
  });
  it("a claim whose signature isn't over this code is refused", async () => {
    const s = await setup();
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, await s.tok(s.A), { name: "x" })).json()) as { code: string };
    const sk = generatePrivateKey();
    expect((await s.call("POST", "/pairings/claim", undefined, { code: p.code, ...signMessage(sk, pairingMessage("GENDO-AAAA-AAAA")) })).status).toBe(400);
  });
  it("only the vault's owners make codes, see or confirm a pairing", async () => {
    const s = await setup();
    const x = await s.tok(s.X);
    expect((await s.call("POST", `/vaults/${policy}/pairings`, x, { name: "x" })).status).toBe(403);
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, await s.tok(s.A), { name: "x" })).json()) as { id: string };
    expect((await s.call("GET", `/pairings/${p.id}`, x)).status).toBe(403);
    expect((await s.call("POST", `/pairings/${p.id}/confirm`, x)).status).toBe(403);
  });
  it("words that don't match: the owner cancels, and the pairing can't be confirmed", async () => {
    const s = await setup();
    const a = await s.tok(s.A);
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, a, { name: "x" })).json()) as { id: string; code: string };
    await s.call("POST", "/pairings/claim", undefined, claimBody(p.code));
    expect((await (await s.call("POST", `/pairings/${p.id}/cancel`, a)).json())).toMatchObject({ status: "cancelled" });
    expect((await s.call("POST", `/pairings/${p.id}/confirm`, a)).status).toBe(409);
  });
  it("confirming needs a claimed pairing", async () => {
    const s = await setup();
    const a = await s.tok(s.A);
    const p = (await (await s.call("POST", `/vaults/${policy}/pairings`, a, { name: "x" })).json()) as { id: string };
    expect((await s.call("POST", `/pairings/${p.id}/confirm`, a)).status).toBe(409);
  });
});
