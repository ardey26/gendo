import { describe, expect, it } from "vitest";
import { WalletError, partialSign, type Connected } from "../src/owner/wallet.ts";

const conn = (signTx: () => Promise<string>) => ({ api: { signTx } }) as unknown as Connected;
describe("partial signing", () => {
  it("a declined signature says so", async () =>
    expect(partialSign(conn(async () => { throw { code: 2, info: "user declined sign tx" }; }), "00")).rejects.toMatchObject({ code: "DECLINED" }));
  it("any other failure is the no-partial-signing message", async () => {
    const e = await partialSign(conn(async () => { throw new Error("not supported"); }), "00").catch((x) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect(e.message).toMatch(/can't co-sign.*Try Lace or Eternl/);
  });
});
