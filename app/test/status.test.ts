import { describe, expect, it } from "vitest";
import type { PendingView } from "../src/owner/types.ts";
import { statusOf } from "../src/owner/status.ts";

const me = "a".repeat(56), other = "b".repeat(56);
const p = (o: Partial<PendingView>): PendingView => ({ id: "1", policy: "p", kind: "proposal", title: "t", cbor: "", recipe: { op: "unpause" }, requiredSigners: [me, other], signedBy: [other], status: "open", createdBy: other, createdAt: 0, ...o });
const now = 1_000_000;

describe("inbox status", () => {
  it("open, live, waiting for me: needs you, can sign, time left", () =>
    expect(statusOf(p({}), { state: "submittable", expiresAtMs: now + 2 * 3_600_000 + 60_000 }, me, now)).toMatchObject({ label: "1 of 2 signatures", canSign: true, needsYou: true, left: "2h 1m left" }));
  it("open but already signed by me: says who it's waiting for, and that nothing is left for me", () =>
    expect(statusOf(p({ signedBy: [me] }), { state: "submittable", expiresAtMs: now + 60_000 }, me, now)).toMatchObject({
      label: "Signed by you. Waiting for 1 more owner.",
      hint: "Nothing more for you to do: it's in the other owners' Needs you, and it goes to the chain by itself once they sign.",
      canSign: false,
      needsYou: false,
    }));
  it("dead: the reason, no signing, rebuild for proposals with a recipe", () => {
    const s = statusOf(p({}), { state: "dead", reason: "its input x#0 was spent by another tx" }, me, now);
    expect(s).toMatchObject({ label: "Dead: its input x#0 was spent by another tx", tone: "dead", canSign: false, canRebuild: true, needsYou: false });
    expect(statusOf(p({ kind: "request" }), { state: "dead", reason: "r" }, me, now).canRebuild).toBe(false);
  });
  it("submitted, landed, failed", () => {
    expect(statusOf(p({ status: "submitted" }), undefined, me, now).label).toBe("Waiting for the chain");
    expect(statusOf(p({ status: "landed" }), undefined, me, now).label).toBe("Landed");
    expect(statusOf(p({ status: "failed", error: "BadInputs" }), undefined, me, now)).toMatchObject({ label: "Failed: BadInputs", canRebuild: true });
  });
});

import { inFlight } from "../src/owner/status.ts";
describe("polling", () => {
  it("polls while anything is submitting, submitted, or open and already signed by me", () => {
    expect(inFlight([p({ status: "submitted" })], me)).toBe(true);
    expect(inFlight([p({ status: "submitting" })], me)).toBe(true);
    expect(inFlight([p({ signedBy: [me, other] , status: "open" })], me)).toBe(true);
    expect(inFlight([p({ status: "landed" }), p({ status: "failed" })], me)).toBe(false);
    expect(inFlight([p({})], me)).toBe(false); // open, waiting for me: nothing changes until I act
  });
});
