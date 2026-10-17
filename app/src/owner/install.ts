// How an AI app installs gendo-agent with this pairing code already in it. Install files are served
// from the app's own domain (until an npm org exists).
export const AGENT_VERSION = "0.1.0";
export const CLAUDE_BUNDLE = "/dl/gendo.mcpb";
export const mcpConfig = (code: string, origin: string) => ({
  command: "npx" as const,
  args: ["-y", `${origin}/dl/gendo-agent-${AGENT_VERSION}.tgz`, "--pair", code, "--server", origin],
});
export const configLine = (code: string, origin: string) => `npx ${mcpConfig(code, origin).args.join(" ")}`;
const encoded = (code: string, origin: string) => encodeURIComponent(btoa(JSON.stringify(mcpConfig(code, origin))));
export const cursorLink = (code: string, origin: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=gendo&config=${encoded(code, origin)}`;
export const lmStudioLink = (code: string, origin: string) => `lmstudio://add_mcp?name=gendo&config=${encoded(code, origin)}`;
