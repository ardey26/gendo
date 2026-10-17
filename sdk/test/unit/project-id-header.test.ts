import { describe, expect, it } from "vitest";
import { withProjectIdHeader } from "../../src/core/provider.js";

describe("the key header behind a proxy", () => {
  it("copies project_id to X-Project-Id for requests to our server, and leaves others alone", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const base = (async (url: string | URL, init?: { headers?: Record<string, string> }) => (seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }), new Response("{}"))) as unknown as typeof fetch;
    const f = withProjectIdHeader(base, "https://app.gendo.cash/chain");
    await f("https://app.gendo.cash/chain/blocks/latest", { headers: { project_id: "gnd_x", lucid: "0.6" } });
    await f("https://other.example/x", { headers: { project_id: "secret" } });
    await f(new URL("https://app.gendo.cash/chain/tx/submit"), { method: "POST", headers: new Headers({ project_id: "gnd_y" }) });
    expect(seen[0]!.headers).toMatchObject({ project_id: "gnd_x", "x-project-id": "gnd_x" });
    expect(seen[1]!.headers["x-project-id"]).toBeUndefined();
    expect(seen[2]!.headers["x-project-id"]).toBe("gnd_y");
  });
});
