// The chain, through the gendo server: an agent connected by pairing has no Blockfrost key of its own.
// Its token makes the server's reads fresh and lets it submit its own allowance spends.
import { Blockfrost, Lucid, SLOT_CONFIG_NETWORK, connect, withProjectIdHeader, withRetries, type LucidEvolution } from "../../sdk/src/core/index.js";
import { AGENT_VERSION } from "./version.js";

/** Every request to our server says which gendo-agent sent it (the server refuses payments from versions too old). */
function withAgentVersion(fetchFn: typeof fetch, base: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) return fetchFn(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return fetchFn(input, { ...init, headers: { ...headers, "x-gendo-agent": AGENT_VERSION } });
  }) as typeof fetch;
}

export async function openChain(server: string, network: "Preprod" | "Custom", token: string): Promise<LucidEvolution> {
  const base = `${server.replace(/\/$/, "")}/chain`;
  // Lucid and the chain queries use the global fetch; behind our proxy the key must travel as X-Project-Id.
  globalThis.fetch = withAgentVersion(withProjectIdHeader(globalThis.fetch, base), base);
  if (network === "Custom") {
    const g = (await (await fetch(`${base}/genesis`)).json()) as { system_start: number; slot_length: number };
    SLOT_CONFIG_NETWORK.Custom = { zeroTime: g.system_start * 1000, zeroSlot: 0, slotLength: g.slot_length * 1000 };
    return Lucid(withRetries(new Blockfrost(base, token)), "Custom");
  }
  return connect({ network, blockfrostUrl: base, blockfrostProjectId: token });
}
