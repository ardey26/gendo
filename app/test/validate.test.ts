import { describe, expect, it } from "vitest";
import { agentProblems, toLovelace, type AgentForm } from "../src/owner/validate.ts";

const ok: AgentForm = { name: "payout-bot", agentKey: "9".repeat(56), perPayment: "10", budget: "25", period: "day", payees: ["addr_test1qok"], expires: "2099-01-01", fund: "40" };
const opts = { isNew: true, nowMs: Date.UTC(2026, 9, 13), owners: ["1".repeat(56)], isKeyAddress: (s: string) => s.startsWith("addr_test1q") };

describe("agent form", () => {
  it("accepts a sane agent", () => expect(agentProblems(ok, opts)).toEqual([]));
  it("refuses a cap above the budget: the chain would", () =>
    expect(agentProblems({ ...ok, perPayment: "30" }, opts)).toContain("The per-payment cap can't be above the budget: the chain refuses it."));
  it("refuses script or malformed payees, duplicates, none at all", () => {
    expect(agentProblems({ ...ok, payees: ["addr_test1wscript"] }, opts).join(" ")).toMatch(/isn't a wallet address/);
    expect(agentProblems({ ...ok, payees: ["addr_test1qok", "addr_test1qok"] }, opts).join(" ")).toMatch(/twice/);
    expect(agentProblems({ ...ok, payees: [] }, opts).join(" ")).toMatch(/at least one payee/);
  });
  it("refuses an agent key that is an owner, or isn't a key hash", () => {
    expect(agentProblems({ ...ok, agentKey: "1".repeat(56) }, opts).join(" ")).toMatch(/owner key/);
    expect(agentProblems({ ...ok, agentKey: "xyz" }, opts).join(" ")).toMatch(/56 hex/);
  });
  it("refuses a past expiry and empty amounts", () => {
    expect(agentProblems({ ...ok, expires: "2020-01-01" }, opts).join(" ")).toMatch(/future/);
    expect(agentProblems({ ...ok, perPayment: "" }, opts).join(" ")).toMatch(/per-payment cap/);
  });
  it("parses ADA amounts exactly", () => {
    expect([toLovelace("10"), toLovelace("0.5"), toLovelace("1.000001"), toLovelace("1.0000001"), toLovelace("-1"), toLovelace("x")]).toEqual([10_000_000n, 500_000n, 1_000_001n, undefined, undefined, undefined]);
  });
});
