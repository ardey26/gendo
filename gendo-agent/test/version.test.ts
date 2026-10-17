// One version, written in four places: the package, the Claude Desktop manifest, the app's install
// links and the agent itself. A release that forgets one would install or report the wrong thing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_VERSION } from "../src/version.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
describe("the agent's version", () => {
  it("is the same everywhere it's written", () => {
    expect(JSON.parse(read("../package.json")).version).toBe(AGENT_VERSION);
    expect(JSON.parse(read("../manifest.json")).version).toBe(AGENT_VERSION);
    expect(read("../../app/src/owner/install.ts")).toContain(`AGENT_VERSION = "${AGENT_VERSION}"`);
  });
});
