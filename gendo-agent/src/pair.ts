// One pairing step: claim the code once (proving this machine holds the key), then ask whether the
// owners have confirmed and funded it. Every answer is phrased for the person reading the AI's reply.
// The confirm words always come from this machine's own key, never from the server: if a server ever
// swapped in another key, the owner would see different words in the app.
import { confirmWords, pairingMessage, signMessage, statusMessage } from "../../sdk/src/core/pairing.js";
import { olderThan } from "../../sdk/src/core/version.js";
import type { Home } from "./home.js";
import { AGENT_VERSION } from "./version.js";

export type Connection = {
  status: "unknown" | "expired" | "claimed" | "confirmed" | "ready" | "error";
  words?: string;
  name?: string;
  message: string;
  /** Set when a newer gendo-agent exists (or a newer one is required for payments): for the AI to tell the user. */
  update?: string;
};

/** What to tell the user about this version, from the server's latest and minimum. */
export function updateNote(latest: string | undefined, min: string | undefined): string | undefined {
  if (min && olderThan(AGENT_VERSION, min))
    return `Payments need gendo ${min} or later; this agent runs ${AGENT_VERSION}. Reinstall it from Connect an agent in the gendo app: it keeps its key and budget.`;
  if (latest && olderThan(AGENT_VERSION, latest))
    return `An update to gendo ${latest} is available (this agent runs ${AGENT_VERSION}). Reinstall it from Connect an agent in the gendo app when convenient: it keeps its key and budget.`;
  return undefined;
}

export async function step(h: Home, fetchFn: typeof fetch = fetch, opts: { wantToken?: boolean } = {}): Promise<Connection> {
  const words = confirmWords(h.pkh);
  const url = (p: string) => `${h.state.server.replace(/\/$/, "")}${p}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetchFn(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, string> };
  };
  try {
    let usedBefore = false;
    if (!h.state.claimed) {
      const r = await post("/pairings/claim", { code: h.state.code, ...signMessage(h.sk, pairingMessage(h.state.code)) });
      if (r.status === 404) return { status: "expired", message: r.body.error ?? "That pairing code expired. Ask the vault owner for a new one." };
      if (r.status === 409) usedBefore = true; // by this machine before a crash, or by another agent: status tells which
      else if (r.status !== 200) return { status: "error", message: r.body.error ?? `the gendo server answered ${r.status}` };
      else h.save({ claimed: true });
    }
    const ms = Date.now();
    const wantToken = opts.wantToken || !h.state.ready?.token;
    const r = await post("/agent/status", { ms, ...signMessage(h.sk, statusMessage(ms)), ...(wantToken ? { wantToken: true } : {}), version: AGENT_VERSION });
    const b = r.body;
    if (r.status !== 200) return { status: "error", message: b.error ?? `the gendo server answered ${r.status}` };
    const note = updateNote(b.latestVersion, b.minVersion);
    const update = note ? { update: note } : {};
    if (b.status === "unknown")
      return usedBefore
        ? { status: "unknown", message: "Another agent used this code first. Tell the vault owner to press \"They don't\" in the gendo app and get a new code." }
        : { status: "unknown", message: "This pairing was cancelled or never finished. Ask the vault owner for a new code." };
    if (usedBefore) h.save({ claimed: true });
    if (b.status === "ready") {
      const token = b.token ?? h.state.ready?.token;
      if (!token) return { status: "error", words, message: "Connected, but the server sent no access token. Restart the app to try again." };
      h.save({ ready: { vaultId: b.vaultId!, unit: b.unit!, token } });
      return { status: "ready", words, name: b.name, message: `Connected as ${b.name} (${words}). Ready to pay within its budget.`, ...update };
    }
    if (b.status === "claimed") return { status: "claimed", words, name: b.name, message: `Paired as ${words}. Ask the vault owner to check these words match in the gendo app, then set a budget.`, ...update };
    return { status: "confirmed", words, name: b.name, message: `Paired as ${words}; the owners are setting the budget. Nothing to do here.`, ...update };
  } catch (e) {
    return { status: "error", message: `Can't reach the gendo server (${(e as Error).message}).` };
  }
}
