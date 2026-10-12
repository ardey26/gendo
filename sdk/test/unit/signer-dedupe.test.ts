import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkIntent } from "../../src/node/signer/dedupe.js";
import { loadState, saveState } from "../../src/node/signer/state.js";

const prev = { hash: "aa".repeat(32), inputs: [{ txHash: "bb".repeat(32), index: 0 }], ttlMs: 1000, at: 0 };

describe("signer intent dedupe", () => {
  it("signs a new intent", () => expect(checkIntent(undefined, "cc".repeat(32), undefined)).toEqual({ ok: true }));
  it("re-signs the same body (harmless: a tx lands at most once)", () =>
    expect(checkIntent(prev, prev.hash, undefined)).toEqual({ ok: true }));
  it("refuses a different body when the earlier tx landed (double pay)", () =>
    expect(checkIntent(prev, "cc".repeat(32), "landed")).toMatchObject({ ok: false, reason: expect.stringMatching(/already paid/) }));
  it("refuses a different body while the earlier tx is undecided", () =>
    expect(checkIntent(prev, "cc".repeat(32), "unknown")).toMatchObject({ ok: false }));
  it("refuses a different body when it can't check the chain at all", () =>
    expect(checkIntent(prev, "cc".repeat(32), undefined)).toMatchObject({ ok: false }));
  it("allows the rebuild once the earlier tx can never land", () =>
    expect(checkIntent(prev, "cc".repeat(32), "never")).toEqual({ ok: true }));
});

describe("signer state persistence", () => {
  it("round-trips counters and intents; prunes counters older than 24 h", () => {
    const path = join(mkdtempSync(join(tmpdir(), "signer-")), "state.json");
    const now = 100_000_000;
    saveState(path, { signed: [{ at: now - 1000, assets: { lovelace: 5n, ["ab".repeat(28) + "01"]: 3n } }, { at: now - 90_000_000, assets: { lovelace: 9n } }], intents: { X: prev } }, now);
    const s = loadState(path);
    expect(s.signed).toEqual([{ at: now - 1000, assets: { lovelace: 5n, ["ab".repeat(28) + "01"]: 3n } }]);
    expect(s.intents.X).toEqual(prev);
  });
  it("loads a state file written before per-asset budgets (lovelace only)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "signer-")), "state.json");
    writeFileSync(path, JSON.stringify({ signed: [{ at: 7, lovelace: "5" }], intents: {} }));
    expect(loadState(path).signed).toEqual([{ at: 7, assets: { lovelace: 5n } }]);
  });
  it("starts empty without a file", () => expect(loadState(join(tmpdir(), "nope-" + Date.now()))).toEqual({ signed: [], intents: {} }));
});
