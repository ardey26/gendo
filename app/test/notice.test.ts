import { describe, expect, it } from "vitest";
import { noticeSeen, markNoticeSeen } from "../src/ui/notice.ts";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("the early-preview notice", () => {
  it("shows until it's been seen, then never again in this browser", () => {
    const s = mem();
    expect(noticeSeen(s)).toBe(false);
    markNoticeSeen(s);
    expect(noticeSeen(s)).toBe(true);
  });
  it("storage that throws (private mode) never blocks the app: treat it as seen after closing", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(noticeSeen(broken)).toBe(false);
    expect(() => markNoticeSeen(broken)).not.toThrow();
  });
});
