import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHome } from "../src/home.js";
import { step } from "../src/pair.js";

const fake = (routes: Record<string, () => [number, unknown]>) => {
  const seen: string[] = [];
  const f = (async (url: string) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const [status, body] = routes[path]!();
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, seen };
};

describe("pairing from the agent's side", () => {
  const home = () => openHome(mkdtempSync(join(tmpdir(), "gendo-agent-")), "GENDO-AAAA-BBBB", "https://x.test");
  it("claims once, then only asks for status", async () => {
    const h = home();
    const s = fake({ "/pairings/claim": () => [200, { id: "p", words: "blue-otter-42" }], "/agent/status": () => [200, { status: "claimed", words: "blue-otter-42", name: "My Claude" }] });
    expect(await step(h, s.f)).toMatchObject({ status: "claimed", words: "blue-otter-42" });
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
});
