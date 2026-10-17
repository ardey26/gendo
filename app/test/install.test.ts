import { describe, expect, it } from "vitest";
import { AGENT_VERSION, configLine, cursorLink, lmStudioLink, mcpConfig } from "../src/owner/install.ts";

const O = "https://app.gendo.cash", C = "GENDO-7K3F-Q9AB";
describe("install options", () => {
  it("the config line installs this version from our own domain, with the code", () =>
    expect(configLine(C, O)).toBe(`npx -y ${O}/dl/gendo-agent-${AGENT_VERSION}.tgz --pair ${C} --server ${O}`));
  it("Cursor and LM Studio links carry the same config, base64", () => {
    const cfg = mcpConfig(C, O);
    const b64 = encodeURIComponent(btoa(JSON.stringify(cfg)));
    expect(cursorLink(C, O)).toBe(`cursor://anysphere.cursor-deeplink/mcp/install?name=gendo&config=${b64}`);
    expect(lmStudioLink(C, O)).toBe(`lmstudio://add_mcp?name=gendo&config=${b64}`);
    expect(cfg).toEqual({ command: "npx", args: ["-y", `${O}/dl/gendo-agent-${AGENT_VERSION}.tgz`, "--pair", C, "--server", O] });
  });
});
