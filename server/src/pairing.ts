// server/src/pairing.ts
// Connecting an agent: an owner makes a short code, the agent claims it by signing it with its own key,
// owners check three words made from that key, then set its budget. The server sees public keys only.
import { randomBytes, randomInt } from "node:crypto";
import type { Context, Hono } from "hono";
import { confirmWords, pairingMessage, verifyMessage } from "../../sdk/src/core/pairing.js";
import { sha256, type mountAuth } from "./auth.js";
import type { PairingRow, openStore } from "./store.js";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const TTL_MS = 15 * 60_000;
const isPolicy = (s: string) => /^[0-9a-f]{56}$/.test(s);
const four = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const newCode = () => `GENDO-${four()}-${four()}`;
const norm = (code: string) => code.trim().toUpperCase();

export type PairingDeps = { store: ReturnType<typeof openStore>; now: () => number };

export function mountPairing(app: Hono, d: PairingDeps, auth: ReturnType<typeof mountAuth>) {
  const view = (r: PairingRow) => ({
    id: r.id, policy: r.policy, name: r.name, expiresAt: r.expires_at,
    status: r.status === "open" && d.now() > r.expires_at ? "expired" : r.status,
    ...(r.agent ? { agent: r.agent, words: confirmWords(r.agent) } : {}),
  });
  /** The pairing, if the caller owns its vault; otherwise the error response. */
  const ownersPairing = async (c: Context): Promise<PairingRow | Response> => {
    const r = d.store.getPairing(c.req.param("id") ?? "");
    if (!r) return c.json({ error: "no such pairing" }, 404);
    const who = await auth.ownerOf(c, r.policy);
    return typeof who === "string" ? r : who;
  };

  app.post("/vaults/:policy/pairings", async (c) => {
    const policy = c.req.param("policy");
    if (!isPolicy(policy)) return c.json({ error: "bad vault id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    const { name } = await c.req.json<{ name?: unknown }>();
    if (typeof name !== "string" || !name.trim() || name.length > 60) return c.json({ error: "name the agent (1 to 60 characters)" }, 400);
    const code = newCode(), id = randomBytes(12).toString("hex"), now = d.now();
    d.store.putPairing({ id, policy, name: name.trim(), createdBy: who, codeHash: sha256(code), expiresAt: now + TTL_MS, createdAt: now });
    return c.json({ id, code, expiresAt: now + TTL_MS });
  });

  app.post("/pairings/claim", async (c) => {
    const { code, publicKey, signature } = await c.req.json<{ code?: unknown; publicKey?: unknown; signature?: unknown }>();
    if (typeof code !== "string" || typeof publicKey !== "string" || typeof signature !== "string" || code.length > 32 || publicKey.length > 128 || signature.length > 256)
      return c.json({ error: "code, publicKey and signature are required" }, 400);
    const r = d.store.pairingByCode(sha256(norm(code)));
    if (!r || (r.status === "open" && d.now() > r.expires_at)) return c.json({ error: "That pairing code is unknown or expired. Ask the vault owner for a new one." }, 404);
    if (r.status !== "open") return c.json({ error: "That pairing code was already used." }, 409);
    const agent = verifyMessage(publicKey, pairingMessage(norm(code)), signature);
    if (!agent) return c.json({ error: "the signature doesn't match this code" }, 400);
    if (!d.store.claimPairing(r.id, agent, publicKey)) return c.json({ error: "That pairing code was already used." }, 409);
    return c.json({ id: r.id, words: confirmWords(agent) });
  });

  app.get("/pairings/:id", async (c) => {
    const r = await ownersPairing(c);
    return r instanceof Response ? r : c.json(view(r));
  });

  app.post("/pairings/:id/confirm", async (c) => {
    const r = await ownersPairing(c);
    if (r instanceof Response) return r;
    if (!d.store.setPairingStatus(r.id, "claimed", "confirmed")) return c.json({ error: "nothing to confirm yet" }, 409);
    return c.json(view(d.store.getPairing(r.id)!));
  });

  app.post("/pairings/:id/cancel", async (c) => {
    const r = await ownersPairing(c);
    if (r instanceof Response) return r;
    if (!["open", "claimed"].includes(r.status) || !d.store.setPairingStatus(r.id, r.status, "cancelled")) return c.json({ error: "too late to cancel" }, 409);
    return c.json(view(d.store.getPairing(r.id)!));
  });
}
