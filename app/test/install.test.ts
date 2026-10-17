import { describe, expect, it } from "vitest";
import { AGENT_VERSION, configLine, cursorLink, lmStudioLink, mcpConfig, versionNote } from "../src/owner/install.ts";

const O = "https://app.gendo.cash", C = "GENDO-7K3F-Q9AB";
describe("install options", () => {
  it("the config line installs this exact version from npm, with the code", () =>
    expect(configLine(C, O)).toBe(`npx -y @gendo-cash/agent@${AGENT_VERSION} --pair ${C} --server ${O}`));
  it("Cursor and LM Studio links carry the same config, base64", () => {
    const cfg = mcpConfig(C, O);
    const b64 = encodeURIComponent(btoa(JSON.stringify(cfg)));
    expect(cursorLink(C, O)).toBe(`cursor://anysphere.cursor-deeplink/mcp/install?name=gendo&config=${b64}`);
    expect(lmStudioLink(C, O)).toBe(`lmstudio://add_mcp?name=gendo&config=${b64}`);
    expect(cfg).toEqual({ command: "npx", args: ["-y", `@gendo-cash/agent@${AGENT_VERSION}`, "--pair", C, "--server", O] });
  });
  it("says which gendo an agent runs, and whether it needs an update", () => {
    expect(versionNote(undefined, { latest: "0.2.0", min: "0.1.1" })).toBeUndefined(); // not reported yet
    expect(versionNote("0.2.0", { latest: "0.2.0", min: "0.1.1" })).toEqual({ text: "gendo 0.2.0", tone: "ok" });
    expect(versionNote("0.1.1", { latest: "0.2.0", min: "0.1.1" })).toEqual({ text: "gendo 0.1.1 · update available", tone: "update" });
    expect(versionNote("0.1.0", { latest: "0.2.0", min: "0.1.1" })).toEqual({ text: "gendo 0.1.0 · update required to pay", tone: "required" });
  });
});
