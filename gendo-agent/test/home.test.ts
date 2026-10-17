import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHome } from "../src/home.js";

describe("the agent's home", () => {
  it("makes a key once, readable only by this user, and reuses it for the same code", () => {
    const dir = mkdtempSync(join(tmpdir(), "gendo-agent-"));
    const a = openHome(dir, "GENDO-AAAA-BBBB", "https://app.gendo.cash");
    const b = openHome(dir, "gendo-aaaa-bbbb ", "https://app.gendo.cash"); // the same code, typed loosely
    expect(b.pkh).toBe(a.pkh);
    expect(statSync(join(a.dir, "agent.sk")).mode & 0o777).toBe(0o600);
    expect(openHome(dir, "GENDO-CCCC-DDDD", "https://app.gendo.cash").pkh).not.toBe(a.pkh);
  });
  it("remembers state across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "gendo-agent-"));
    openHome(dir, "GENDO-AAAA-BBBB", "s").save({ claimed: true });
    expect(openHome(dir, "GENDO-AAAA-BBBB", "s").state.claimed).toBe(true);
  });
});
