import { describe, expect, it } from "vitest";
import { seedHue } from "../src/ui/avatar.ts";

describe("seeded avatar colors", () => {
  it("the same id always gets the same color", () => expect(seedHue("ab".repeat(28))).toBe(seedHue("ab".repeat(28))));
  it("picks from ten hues spaced 30° apart, so two colors are never near-twins", () => {
    const hues = new Set(Array.from({ length: 60 }, (_, i) => seedHue(`${i}`.padStart(56, "0"))));
    for (const h of hues) expect(h % 30).toBe(0);
    expect(hues.size).toBeGreaterThanOrEqual(8);
  });
  it("never lands on red, which the app keeps for warnings", () => {
    for (let i = 0; i < 500; i++) {
      const h = seedHue(`id-${i}`);
      expect(h).toBeGreaterThanOrEqual(30);
      expect(h).toBeLessThan(330);
    }
  });
});
