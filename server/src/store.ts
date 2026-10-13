// server/src/store.ts
// Public listings: a vault's display name and whether it may be indexed.
// Everything else the public page shows comes from the chain.
import { DatabaseSync } from "node:sqlite";

export type Listing = { policy: string; name: string; listed: boolean };
export type PendingRow = {
  id: string; policy: string; kind: string; title: string; cbor: string; body_hash: string; recipe: string | null; required: string;
  created_by: string; created_at: number; status: string; tx_hash: string | null; error: string | null; unit: string | null;
};

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("create table if not exists vaults (policy text primary key, name text not null, listed integer not null default 0)");
  db.exec("create table if not exists sessions (token_hash text primary key, pkh text not null, expires_at integer not null)");
  const putSession = db.prepare("insert into sessions (token_hash, pkh, expires_at) values (?, ?, ?)");
  const getSession = db.prepare("select pkh, expires_at from sessions where token_hash = ?");
  db.exec(`create table if not exists pending (
    id text primary key, policy text not null, kind text not null, title text not null, cbor text not null,
    body_hash text not null, recipe text, required text not null, created_by text not null, created_at integer not null,
    status text not null, tx_hash text, error text, unit text)`);
  db.exec("create table if not exists witnesses (pending_id text not null, key_hash text not null, witness text not null, primary key (pending_id, key_hash))");
  const insPending = db.prepare(
    "insert into pending (id, policy, kind, title, cbor, body_hash, recipe, required, created_by, created_at, status, unit) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
  );
  const getPending = db.prepare("select * from pending where id = ?");
  const byPolicy = db.prepare("select * from pending where policy = ? order by created_at desc limit 200");
  const allOpen = db.prepare("select * from pending order by created_at desc limit 1000");
  const setStatus = db.prepare("update pending set status = ?, tx_hash = ?, error = ? where id = ? and status = ?");
  const putWitness = db.prepare("insert or ignore into witnesses (pending_id, key_hash, witness) values (?, ?, ?)");
  const witnessesOf = db.prepare("select key_hash, witness from witnesses where pending_id = ?");
  const get = db.prepare("select policy, name, listed from vaults where policy = ?");
  const put = db.prepare(
    "insert into vaults (policy, name, listed) values (?, ?, ?) on conflict(policy) do update set name = excluded.name, listed = excluded.listed",
  );
  return {
    get(policy: string): Listing | undefined {
      const r = get.get(policy) as { policy: string; name: string; listed: number } | undefined;
      return r ? { policy: r.policy, name: r.name, listed: r.listed === 1 } : undefined;
    },
    put(l: Listing) {
      put.run(l.policy, l.name, l.listed ? 1 : 0);
    },
    putSession(hash: string, pkh: string, expiresAt: number) {
      putSession.run(hash, pkh, expiresAt);
    },
    getSession(hash: string): { pkh: string; expiresAt: number } | undefined {
      const r = getSession.get(hash) as { pkh: string; expires_at: number } | undefined;
      return r ? { pkh: r.pkh, expiresAt: r.expires_at } : undefined;
    },
    insertPending(r: { id: string; policy: string; kind: string; title: string; cbor: string; bodyHash: string; recipe: unknown; required: string[]; createdBy: string; createdAt: number; unit?: string }) {
      insPending.run(r.id, r.policy, r.kind, r.title, r.cbor, r.bodyHash, JSON.stringify(r.recipe ?? null), JSON.stringify(r.required), r.createdBy, r.createdAt, r.unit ?? null);
    },
    getPending: (id: string) => getPending.get(id) as PendingRow | undefined,
    pendingFor: (policy: string) => byPolicy.all(policy) as PendingRow[],
    recentPending: () => allOpen.all() as PendingRow[],
    /** Compare-and-set: only one caller moves a row out of `from`. */
    setStatus: (id: string, from: string, to: string, txHash: string | null, error: string | null) => setStatus.run(to, txHash, error, id, from).changes === 1,
    putWitness: (id: string, keyHash: string, witness: string) => void putWitness.run(id, keyHash, witness),
    witnessesOf: (id: string) => witnessesOf.all(id) as { key_hash: string; witness: string }[],
  };
}
