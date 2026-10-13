// sdk/test/unit/liveness.test.ts
import { describe, expect, it } from "vitest";
import type { ChainQuery } from "../../src/core/idempotency.js";
import { liveness } from "../../src/core/liveness.js";

const t = { hash: "aa".repeat(32), inputs: [{ txHash: "bb".repeat(32), index: 0 }], ttlMs: 1_000_000 };
const q = (o: Partial<ChainQuery>): ChainQuery => ({
  txExists: async () => false, spenderOf: async () => null, txInputs: async () => undefined, tipMs: async () => undefined, txMetadata: async () => undefined, ...o,
});
const unknown = async () => undefined;

describe("liveness", () => {
  it("landed when the tx is on chain", async () =>
    expect(await liveness(q({ txExists: async () => true }), t, 0, unknown)).toEqual({ state: "landed", hash: t.hash }));
  it("dead when another tx spent an input", async () =>
    expect(await liveness(q({ spenderOf: async () => "cc".repeat(32) }), t, 0, unknown)).toEqual({ state: "dead", reason: `its input ${"bb".repeat(32)}#0 was spent by tx ${"cc".repeat(32)}` }));
  it("dead when a provider without a spender index no longer lists the input", async () =>
    expect((await liveness(q({ spenderOf: async () => undefined }), t, 0, async () => false)).state).toBe("dead"));
  it("dead after its TTL", async () => expect((await liveness(q({}), t, 1_000_000, unknown)).state).toBe("dead"));
  it("submittable otherwise, with its deadline", async () =>
    expect(await liveness(q({}), t, 999_999, unknown)).toEqual({ state: "submittable", expiresAtMs: 1_000_000 }));
});
