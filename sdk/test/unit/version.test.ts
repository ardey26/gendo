import { describe, expect, it } from "vitest";
import { olderThan } from "../../src/core/version.js";

describe("comparing versions", () => {
  it("compares numerically, part by part", () => {
    expect(olderThan("0.1.0", "0.1.1")).toBe(true);
    expect(olderThan("0.1.1", "0.1.1")).toBe(false);
    expect(olderThan("0.2.0", "0.1.9")).toBe(false);
    expect(olderThan("0.9.0", "0.10.0")).toBe(true);
  });
  it("anything unreadable counts as older (an agent too old to say)", () => {
    expect(olderThan(undefined, "0.1.1")).toBe(true);
    expect(olderThan("junk", "0.1.1")).toBe(true);
  });
});
