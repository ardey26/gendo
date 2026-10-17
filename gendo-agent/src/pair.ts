// One pairing step: claim the code once (proving this machine holds the key), then ask whether the
// owners have confirmed and funded it. Every answer is phrased for the person reading the AI's reply.
import { pairingMessage, signMessage, statusMessage } from "../../sdk/src/core/pairing.js";
import type { Home } from "./home.js";

export type Connection = { status: "unknown" | "expired" | "claimed" | "confirmed" | "ready" | "error"; words?: string; name?: string; message: string };

export async function step(h: Home, fetchFn: typeof fetch = fetch): Promise<Connection> {
  const url = (p: string) => `${h.state.server.replace(/\/$/, "")}${p}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetchFn(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, string> };
  };
  try {
    if (!h.state.claimed) {
      const r = await post("/pairings/claim", { code: h.state.code, ...signMessage(h.sk, pairingMessage(h.state.code)) });
      if (r.status === 404) return { status: "expired", message: r.body.error ?? "That pairing code expired. Ask the vault owner for a new one." };
      if (r.status !== 200 && r.status !== 409) return { status: "error", message: r.body.error ?? `the gendo server answered ${r.status}` };
      h.save({ claimed: true });
    }
    const ms = Date.now();
    const r = await post("/agent/status", { ms, ...signMessage(h.sk, statusMessage(ms)) });
    const b = r.body;
    if (r.status !== 200) return { status: "error", message: b.error ?? `the gendo server answered ${r.status}` };
    if (b.status === "ready") {
      h.save({ ready: { vaultId: b.vaultId!, unit: b.unit!, token: b.token! } });
      return { status: "ready", words: b.words, name: b.name, message: `Connected as ${b.name} (${b.words}). Ready to pay within its budget.` };
    }
    if (b.status === "claimed")
      return { status: "claimed", words: b.words, name: b.name, message: `Paired as ${b.words}. Ask the vault owner to check these words match in the gendo app, then set a budget.` };
    if (b.status === "confirmed") return { status: "confirmed", words: b.words, name: b.name, message: `Paired as ${b.words}; the owners are setting the budget. Nothing to do here.` };
    return { status: "unknown", message: "This pairing was cancelled or never finished. Ask the vault owner for a new code." };
  } catch (e) {
    return { status: "error", message: `Can't reach the gendo server (${(e as Error).message}).` };
  }
}
