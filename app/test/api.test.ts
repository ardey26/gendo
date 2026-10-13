import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, SERVER_DOWN, api } from "../src/owner/api.ts";

afterEach(() => vi.unstubAllGlobals());
describe("api", () => {
  it("a network failure means the server is down, said plainly", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(api.myVaults()).rejects.toEqual(new ApiError(0, SERVER_DOWN));
  });
  it("the server's error text comes through", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "you aren't an owner of that vault" }), { status: 403 }));
    await expect(api.addVault("gendo:preprod:x")).rejects.toMatchObject({ status: 403, message: "you aren't an owner of that vault" });
  });
});
