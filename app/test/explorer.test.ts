import { describe, expect, it } from "vitest";
import { explorerUrl } from "../src/ui/explorer.ts";

describe("explorer links", () => {
  it("preprod transactions and addresses go to Cardanoscan's preprod site", () => {
    expect(explorerUrl("Preprod", "a".repeat(64))).toBe(`https://preprod.cardanoscan.io/transaction/${"a".repeat(64)}`);
    expect(explorerUrl("Preprod", "addr_test1qprs4rpgwr")).toBe("https://preprod.cardanoscan.io/address/addr_test1qprs4rpgwr");
  });
  it("the devnet has no public explorer, and anything else isn't a link", () => {
    expect(explorerUrl("Custom", "a".repeat(64))).toBeUndefined();
    expect(explorerUrl("Preprod", "40 ADA")).toBeUndefined();
    expect(explorerUrl("Preprod", "b".repeat(56))).toBeUndefined();
  });
});
