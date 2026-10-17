// The paying agent's three tools, shared by the MCP server (separate signer) and gendo-agent (paired,
// in-process signer). None of them can raise a limit: only the owners can.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { budget, pay, requestApproval, type AgentSession } from "../../sdk/src/node/session.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });

const payment = {
  to: z.string().describe("Payee's exact Cardano address (addr_test1...). Must be on the approved list."),
  amount_ada: z.number().positive().describe("Amount in ADA, e.g. 4.5"),
  intent_id: z.string().min(1).describe("Stable id of what you're paying, e.g. the invoice number. Reuse it on retries."),
  purpose: z.string().describe("Short human-readable reason, recorded on-chain with the payment"),
};

/**
 * `session` resolves to the agent's session, or to why it isn't ready yet (gendo-agent before its budget lands).
 * `onResult` sees every tool result (gendo-agent reconnects when the server stops accepting its token).
 */
export function registerTools(server: McpServer, session: () => Promise<AgentSession | { notReady: string }>, onResult?: (r: unknown) => void) {
  const ready = async <T>(run: (s: AgentSession) => Promise<T>) => {
    const s = await session();
    const out = "notReady" in s ? { status: "not_ready", message: s.notReady } : await run(s);
    onResult?.(out);
    return json(out);
  };

  server.registerTool(
    "get_budget",
    {
      title: "Check the budget",
      description: "What you may spend right now: per-payment and per-period limits, what's left this period, when it resets, approved payees, expiry, and whether the owners paused spending.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => ready((s) => budget(s)),
  );

  server.registerTool(
    "pay",
    {
      title: "Pay from the allowance",
      description:
        "Pay an approved payee within the limits. Returns paid, already_paid (this intent_id was paid before; nothing new was sent), or blocked with a code and the next step. Over-limit amounts are blocked by the chain; use request_approval for those.",
      inputSchema: payment,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => pay(s, args)),
  );

  server.registerTool(
    "request_approval",
    {
      title: "Ask the owners to approve a payment",
      description:
        "For a payment over your limits. Sends it to the vault owners to review and sign; nothing is paid until they do.",
      inputSchema: { ...payment, reason: z.string().describe("Why this payment should exceed the limits") },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => requestApproval(s, args)),
  );
}
