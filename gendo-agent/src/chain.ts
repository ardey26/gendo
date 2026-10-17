// The chain, through the gendo server: an agent connected by pairing has no Blockfrost key of its own.
// Its token makes the server's reads fresh and lets it submit its own allowance spends.
import { Blockfrost, Lucid, SLOT_CONFIG_NETWORK, connect, withRetries, type LucidEvolution } from "../../sdk/src/core/index.js";

export async function openChain(server: string, network: "Preprod" | "Custom", token: string): Promise<LucidEvolution> {
  const base = `${server.replace(/\/$/, "")}/chain`;
  if (network === "Custom") {
    const g = (await (await fetch(`${base}/genesis`)).json()) as { system_start: number; slot_length: number };
    SLOT_CONFIG_NETWORK.Custom = { zeroTime: g.system_start * 1000, zeroSlot: 0, slotLength: g.slot_length * 1000 };
    return Lucid(withRetries(new Blockfrost(base, token)), "Custom");
  }
  return connect({ network, blockfrostUrl: base, blockfrostProjectId: token });
}
