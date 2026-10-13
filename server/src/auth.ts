// server/src/auth.ts
// Owner sign-in: the wallet signs a one-time challenge (CIP-8). A session names a key,
// not a vault; each vault request checks that key against the vault's owners on chain.
import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { utf8ToHex } from "../../sdk/src/core/bytes.js";
import { cip8Signer } from "../../sdk/src/node/auth.js";
import type { openStore } from "./store.js";

const SESSION_MS = 12 * 3_600_000;
const CHALLENGE_MS = 5 * 60_000;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function mountAuth(app: Hono, d: { store: ReturnType<typeof openStore>; now: () => number; owners: (policy: string) => Promise<string[] | undefined> }) {
  const challenges = new Map<string, { addressHex: string; payload: string; exp: number }>();

  app.post("/auth/challenge", async (c) => {
    const { address } = await c.req.json<{ address?: string }>();
    if (!address || !/^[0-9a-f]{58,114}$/.test(address)) return c.json({ error: "address must be the wallet's hex address" }, 400);
    for (const [k, v] of challenges) if (v.exp < d.now()) challenges.delete(k);
    if (challenges.size > 10_000) return c.json({ error: "busy, try again" }, 503);
    const nonce = randomBytes(16).toString("hex");
    const exp = d.now() + CHALLENGE_MS;
    // The wallet shows this text: it names the site and expires, so a relayed request is visible and short-lived.
    const site = new URL(c.req.url).host;
    const payload = utf8ToHex(`Sign in to gendo\nsite: ${site}\nnonce: ${nonce}\nexpires: ${new Date(exp).toISOString()}`);
    challenges.set(nonce, { addressHex: address, payload, exp });
    return c.json({ nonce, payload });
  });

  app.post("/auth/verify", async (c) => {
    const { nonce, signature, key } = await c.req.json<{ nonce?: string; signature?: string; key?: string }>();
    const ch = nonce ? challenges.get(nonce) : undefined;
    if (nonce) challenges.delete(nonce);
    if (!ch || ch.exp < d.now() || !signature || !key) return c.json({ error: "sign-in failed" }, 401);
    const pkh = cip8Signer(ch.addressHex, ch.payload, { signature, key });
    if (!pkh) return c.json({ error: "sign-in failed" }, 401);
    const token = randomBytes(32).toString("hex");
    const expiresAt = d.now() + SESSION_MS;
    d.store.putSession(sha256(token), pkh, expiresAt, d.now());
    return c.json({ token, pkh, expiresAt });
  });

  const sessionPkh = (c: Context): string | undefined => {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "");
    const s = m ? d.store.getSession(sha256(m[1]!)) : undefined;
    return s && s.expiresAt > d.now() ? s.pkh : undefined;
  };
  /** The signed-in owner of `policy`, or a 401/403 response. */
  const ownerOf = async (c: Context, policy: string): Promise<string | Response> => {
    const pkh = sessionPkh(c);
    if (!pkh) return c.json({ error: "sign in first" }, 401);
    const owners = await d.owners(policy);
    if (!owners?.includes(pkh)) return c.json({ error: "not an owner of this vault" }, 403);
    return pkh;
  };
  return { sessionPkh, ownerOf };
}
