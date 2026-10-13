import { describe, expect, it } from "vitest";
import { formatVaultId, parseVaultId } from "../../src/core/vault.js";

describe("vault ids", () => {
  const seed = { txHash: "ab".repeat(32), outputIndex: 1 };
  const ref = { txHash: "cd".repeat(32), outputIndex: 0 };
  it("round-trips with and without a reference script", () => {
    expect(parseVaultId(formatVaultId({ network: "Preprod", seed, refScript: ref }))).toEqual({ network: "Preprod", seed, refScript: ref });
    expect(parseVaultId(`gendo:custom:${"ab".repeat(32)}#1`)).toEqual({ network: "Custom", seed });
  });
  it("refuses anything else, mainnet included", () => {
    for (const bad of ["", "gendo:preprod", `gendo:mainnet:${"ab".repeat(32)}#1`, `gendo:preprod:${"ab".repeat(31)}#1`, `x:preprod:${"ab".repeat(32)}#1`, `gendo:preprod:${"ab".repeat(32)}#1:a:b`])
      expect(() => parseVaultId(bad)).toThrow();
  });
});
