import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmWords } from "../../sdk/src/core/pairing.js";
import { openHome } from "../src/home.js";
import { step } from "../src/pair.js";

const fake = (routes: Record<string, () => [number, unknown]>) => {
  const seen: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname;
    seen.push(path);
    bodies.push(JSON.parse(init?.body ?? "{}"));
    const [status, body] = routes[path]!();
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, seen, bodies };
};

describe("pairing from the agent's side", () => {
  const home = () => openHome(mkdtempSync(join(tmpdir(), "gendo-agent-")), "GENDO-AAAA-BBBB", "https://x.test");
  it("claims once, then only asks for status", async () => {
    const h = home();
    const s = fake({ "/pairings/claim": () => [200, { id: "p", words: "blue-otter-42" }], "/agent/status": () => [200, { status: "claimed", words: "blue-otter-42", name: "My Claude" }] });
    expect(await step(h, s.f)).toMatchObject({ status: "claimed", words: confirmWords(h.pkh) });
    expect(await step(h, s.f)).toMatchObject({ status: "claimed" });
    expect(s.seen).toEqual(["/pairings/claim", "/agent/status", "/agent/status"]);
  });
  it("an expired code says so in plain words", async () => {
    const s = fake({ "/pairings/claim": () => [404, { error: "That pairing code is unknown or expired. Ask the vault owner for a new one." }] });
    expect(await step(home(), s.f)).toMatchObject({ status: "expired", message: expect.stringMatching(/Ask the vault owner for a new one/) });
  });
  it("ready: stores the vault, allowance and token", async () => {
    const h = home();
    const s = fake({ "/pairings/claim": () => [200, { id: "p", words: "w" }], "/agent/status": () => [200, { status: "ready", words: "w", name: "n", vaultId: "gendo:preprod:x", unit: "u", token: "gnd_t" }] });
    expect((await step(h, s.f)).status).toBe("ready");
    expect(h.state.ready).toEqual({ vaultId: "gendo:preprod:x", unit: "u", token: "gnd_t" });
  });
  it("an unreachable server is an error, not a crash", async () => {
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await step(home(), f)).toMatchObject({ status: "error", message: expect.stringMatching(/Can't reach the gendo server/) });
  });
  it("shows the words of its own key, whatever the server says (a lying server is caught by the owner's comparison)", async () => {
    const h = home();
    const s = fake({ "/pairings/claim": () => [200, { id: "p", words: "server-made-1" }], "/agent/status": () => [200, { status: "claimed", words: "server-made-1", name: "n" }] });
    const c = await step(h, s.f);
    expect(c.words).toBe(confirmWords(h.pkh));
    expect(c.message).toContain(confirmWords(h.pkh));
  });
  it("a code someone else used first says so, and what to do", async () => {
    const s = fake({ "/pairings/claim": () => [409, { error: "That pairing code was already used." }], "/agent/status": () => [200, { status: "unknown" }] });
    expect((await step(home(), s.f)).message).toMatch(/another agent used this code first.*They don't/i);
  });
  it("asks for a token only when it has none, and keeps the one it has", async () => {
    const h = home();
    const ready = { status: "ready", words: "w", name: "n", vaultId: "v", unit: "u" };
    const s = fake({ "/pairings/claim": () => [200, { id: "p", words: "w" }], "/agent/status": () => [200, { ...ready, token: "gnd_first" }] });
    await step(h, s.f);
    expect(s.bodies[1]).toMatchObject({ wantToken: true });
    const s2 = fake({ "/agent/status": () => [200, ready] });
    expect((await step(h, s2.f)).status).toBe("ready");
    expect(s2.bodies[0]!.wantToken).toBeUndefined();
    expect(h.state.ready?.token).toBe("gnd_first");
  });
});
