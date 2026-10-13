// app/test/format.test.ts
import { describe, expect, it } from "vitest";
import { ada, allowanceSentence, parsePolicy, periodName } from "../src/public/format.ts";

describe("format", () => {
  it("parses /w/<policy> and rejects anything else", () => {
    expect(parsePolicy("/w/" + "ab".repeat(28))).toBe("ab".repeat(28));
    for (const p of ["/w/", "/w/xyz", "/w/" + "ab".repeat(29), "/x/" + "ab".repeat(28)]) expect(parsePolicy(p)).toBeUndefined();
  });
  it("formats ADA without float noise", () => {
    expect([ada(10_000_000n), ada(1_500_000n), ada(364_003n), ada(0n)]).toEqual(["10", "1.5", "0.364003", "0"]);
  });
  it("names periods", () => {
    expect([periodName(86_400_000n), periodName(3_600_000n), periodName(604_800_000n), periodName(172_800_000n), periodName(90_000n)]).toEqual(["day", "hour", "week", "2 days", "90 seconds"]);
  });
  it("says what an agent may do in one sentence", () => {
    const s = allowanceSentence({
      unit: "u", txHash: "t", lovelace: 0n, status: "active", payees: ["a", "b", "c"], periodMs: 86_400_000n, expiresAt: Date.UTC(2026, 10, 30),
      caps: [{ unit: "lovelace", perPayment: 10_000_000n, perPeriod: 25_000_000n, spentThisPeriod: 0n, leftThisPeriod: 25_000_000n }],
    });
    expect(s).toBe("This agent can pay up to 10 ADA at a time and 25 ADA per day, only to these 3 addresses, until 2026-11-30.");
  });
  it("says so for a malformed allowance", () => {
    expect(allowanceSentence({ unit: "u", txHash: "t", lovelace: 0n, status: "malformed", payees: [], caps: [] })).toBe("Malformed: the agent can't spend it, and owners can reclaim it.");
  });
});
