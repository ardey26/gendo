import { CML } from "../../sdk/src/core/index.ts";
import { describe, expect, it } from "vitest";
import { WalletError, partialSign, type Connected } from "../src/owner/wallet.ts";
import { withChainCheckedUtxos, type Cip30 } from "../src/owner/wallet.ts";

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

describe("the wallet's coins, checked against the chain", () => {
  const addr = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex("11".repeat(28)))).to_address();
  const coin = (tx: string, i: number) =>
    CML.TransactionUnspentOutput.new(CML.TransactionInput.new(CML.TransactionHash.from_hex(tx), BigInt(i)), CML.TransactionOutput.new(addr, CML.Value.from_coin(5_000_000n))).to_cbor_hex();
  const spent = coin("aa".repeat(32), 1), live = coin("bb".repeat(32), 0);
  const api = { getUtxos: async () => [spent, live], getCollateral: async () => [spent] } as unknown as Cip30;
  it("drops coins the chain says are already spent (a wallet that hasn't caught up with a tx it didn't submit)", async () => {
    const w = withChainCheckedUtxos(api, async () => [{ txHash: "bb".repeat(32), outputIndex: 0 }]);
    expect(await w.getUtxos()).toEqual([live]);
    expect(await w.getCollateral!()).toEqual([]);
  });
  it("keeps the wallet's list when the chain can't be asked", async () => {
    const w = withChainCheckedUtxos(api, async () => { throw new Error("chain down"); });
    expect(await w.getUtxos()).toEqual([spent, live]);
  });
});
