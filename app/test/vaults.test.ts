import { describe, expect, it } from "vitest";
import { makeVault } from "../../sdk/src/core/index.ts";
import { consistentVaults } from "../src/owner/vaults.ts";

describe("your vault list", () => {
  it("drops an entry whose vault id isn't the vault the policy names", () => {
    const a = makeVault("Preprod", { txHash: "aa".repeat(32), outputIndex: 0 });
    const idA = `gendo:preprod:${"aa".repeat(32)}#0`, idB = `gendo:preprod:${"bb".repeat(32)}#0`;
    const list = [{ policy: a.hash, vaultId: idA, name: "A", listed: false }, { policy: a.hash, vaultId: idB, name: "forged", listed: false }, { policy: a.hash, vaultId: "junk", name: "x", listed: false }];
    expect(consistentVaults(list).map((v) => v.name)).toEqual(["A"]);
  });
});
