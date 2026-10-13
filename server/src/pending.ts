// server/src/pending.ts
// The inbox. The server stores proposals and owners' witnesses, checks every signature
// against the exact body, and broadcasts once all required signers have signed. It
// never decides what a tx does: each owner's browser recomputes that from the chain.
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyHash, requiredSignersOf, verifiedSigners, withWitnesses } from "../../sdk/src/core/witnesses.js";
import type { mountAuth } from "./auth.js";
import type { PendingRow, openStore } from "./store.js";

export type PendingView = {
  id: string; policy: string; kind: "proposal" | "request"; title: string; cbor: string; recipe: unknown;
  requiredSigners: string[]; signedBy: string[]; status: "open" | "submitting" | "submitted" | "landed" | "failed";
  txHash?: string; error?: string; createdBy: string; createdAt: number;
};
type Deps = {
  store: ReturnType<typeof openStore>;
  now: () => number;
  owners: (policy: string) => Promise<string[] | undefined>;
  submit: (txCbor: string) => Promise<{ ok: true; hash: string } | { ok: false; error: string }>;
  upstream: (pathAndQuery: string) => Promise<Response>;
};
type Auth = ReturnType<typeof mountAuth>;

const isHex = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max && /^[0-9a-f]+$/.test(s) && s.length % 2 === 0;

export function mountPending(app: Hono, d: Deps, auth: Auth) {
  const view = (r: PendingRow): PendingView => ({
    id: r.id, policy: r.policy, kind: r.kind as PendingView["kind"], title: r.title, cbor: r.cbor, recipe: r.recipe ? JSON.parse(r.recipe) : null,
    requiredSigners: JSON.parse(r.required), signedBy: d.store.witnessesOf(r.id).map((w) => w.key_hash),
    status: r.status as PendingView["status"], ...(r.tx_hash ? { txHash: r.tx_hash } : {}), ...(r.error ? { error: r.error } : {}),
    createdBy: r.created_by, createdAt: r.created_at,
  });
  /** A submitted tx that the chain now knows is landed. */
  const refresh = async (r: PendingRow) => {
    if (r.status === "submitted" && r.tx_hash) {
      const res = await d.upstream(`/txs/${r.tx_hash}`).catch(() => undefined);
      if (res?.status === 200) d.store.setStatus(r.id, "submitted", "landed", r.tx_hash, null);
    }
    return view(d.store.getPending(r.id)!);
  };
  /** Store each valid signature by a required signer; submit once everyone has signed. */
  const addWitness = async (r: PendingRow, witness: string) => {
    const required: string[] = JSON.parse(r.required);
    for (const k of verifiedSigners(r.cbor, witness)) if (required.includes(k)) d.store.putWitness(r.id, k, witness);
    const ws = d.store.witnessesOf(r.id);
    if (required.every((k) => ws.some((w) => w.key_hash === k)) && d.store.setStatus(r.id, "open", "submitting", null, null)) {
      const res = await d.submit(withWitnesses(r.cbor, [...new Set(ws.map((w) => w.witness))]));
      if (res.ok) d.store.setStatus(r.id, "submitting", "submitted", res.hash, null);
      else d.store.setStatus(r.id, "submitting", "failed", null, res.error);
    }
    return view(d.store.getPending(r.id)!);
  };
  const insert = (row: Omit<Parameters<Deps["store"]["insertPending"]>[0], "id" | "createdAt" | "bodyHash">) => {
    const id = randomBytes(12).toString("hex");
    d.store.insertPending({ ...row, id, createdAt: d.now(), bodyHash: bodyHash(row.cbor) });
    return d.store.getPending(id)!;
  };

  app.post("/vaults/:policy/pending", async (c) => {
    const policy = c.req.param("policy");
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    const { cbor, witness, title, recipe } = await c.req.json<{ cbor?: unknown; witness?: unknown; title?: unknown; recipe?: unknown }>();
    if (!isHex(cbor, 64_000) || !isHex(witness, 4_000) || typeof title !== "string" || title.length > 200)
      return c.json({ error: "cbor, witness and title are required" }, 400);
    let required: string[];
    try {
      required = requiredSignersOf(cbor);
      if (!verifiedSigners(cbor, witness).includes(who)) return c.json({ error: "the witness isn't your signature over this tx" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const owners = (await d.owners(policy)) ?? [];
    if (!required.length || !required.every((k) => owners.includes(k))) return c.json({ error: "every required signer must be an owner of this vault" }, 400);
    if (!required.includes(who)) return c.json({ error: "you must be one of the tx's required signers" }, 400);
    const row = insert({ policy, kind: "proposal", title, cbor, recipe: recipe ?? null, required, createdBy: who });
    return c.json(await addWitness(row, witness));
  });

  app.get("/vaults/:policy/pending", async (c) => {
    const who = await auth.ownerOf(c, c.req.param("policy"));
    if (typeof who !== "string") return who;
    return c.json(await Promise.all(d.store.pendingFor(c.req.param("policy")).map(refresh)));
  });

  app.get("/me/pending", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const mine = d.store.recentPending().filter((r) => (JSON.parse(r.required) as string[]).includes(who));
    return c.json(await Promise.all(mine.map(refresh)));
  });

  app.post("/pending/:id/witness", async (c: Context) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const r = d.store.getPending(c.req.param("id")!);
    if (!r) return c.json({ error: "no such proposal" }, 404);
    if (!(JSON.parse(r.required) as string[]).includes(who)) return c.json({ error: "you aren't a required signer of this tx" }, 403);
    if (r.status === "failed") return c.json({ error: `this tx failed: ${r.error}` }, 409);
    if (r.status !== "open") return c.json(view(r));
    const { witness } = await c.req.json<{ witness?: unknown }>();
    if (!isHex(witness, 4_000)) return c.json({ error: "witness required" }, 400);
    try {
      if (!verifiedSigners(r.cbor, witness).includes(who)) return c.json({ error: "the witness isn't your signature over this tx" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json(await addWitness(r, witness));
  });

  return { insert, addWitness };
}
