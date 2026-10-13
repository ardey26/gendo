// One MCP tool call, as an agent host makes it; prints the tool's JSON result.
//   tsx mcp/test/call.ts <allowance-unit> <signer-socket> <tool> '<json args>'
// Env: VAULT_HOME (the agent's joined home), VAULT_NETWORK, devnet URLs, and optionally GENDO_SERVER / GENDO_AGENT_TOKEN.
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [unit, socket, tool, args] = process.argv.slice(2) as [string, string, string, string];
const client = new Client({ name: "gendo-call", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: join(import.meta.dirname, "../gendo-mcp"),
    args: ["--allowance", unit, "--signer-socket", socket],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);
const r = await client.callTool({ name: tool, arguments: JSON.parse(args) });
console.log((r.content as { text: string }[])[0]!.text);
await client.close();
