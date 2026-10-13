// app/test/format.test.ts
import { describe, expect, it } from "vitest";
import { ada, allowanceSentence, cleanPurpose, parsePolicy, paymentLine, periodName } from "../src/public/format.ts";

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
  const row = { txHash: "t", time: 0, payees: [{ address: "a", lovelace: 4_000_000n }], fee: 367_842n, allowanceDelta: -4_367_842n };
  it("describes a payment from what the chain says, fee included", () => {
    expect(paymentLine({ ...row, kind: "agent" })).toBe("4 ADA to 1 payee + 0.367842 ADA fee, paid by the agent within its limits");
    expect(paymentLine({ ...row, kind: "co-signed", payees: [{ address: "a", lovelace: 1n }, { address: "b", lovelace: 2n }] })).toBe("0.000003 ADA to 2 payees + 0.367842 ADA fee, approved by owners");
  });
  it("describes an owner change by what it did to the allowance, not by the owner's change output", () => {
    expect(paymentLine({ ...row, kind: "owner", payees: [], allowanceDelta: 10_000_000n })).toBe("Owner change: allowance +10 ADA");
    expect(paymentLine({ ...row, kind: "owner", payees: [], allowanceDelta: -30_000_000n })).toBe("Owner change: allowance -30 ADA");
    expect(paymentLine({ ...row, kind: "unknown", payees: [], allowanceDelta: -1_500_000n })).toBe("Allowance -1.5 ADA");
  });
  it("cleans the agent's note: no control or direction characters, bounded length", () => {
    expect(cleanPurpose("hosting\u202e, October\n\u0000 ")).toBe("hosting, October");
    expect(cleanPurpose("x".repeat(500))).toBe("x".repeat(120) + "…");
  });
});
