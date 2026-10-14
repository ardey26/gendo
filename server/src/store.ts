// server/src/store.ts
// Public listings: a vault's display name and whether it may be indexed.
// Everything else the public page shows comes from the chain.
import { DatabaseSync } from "node:sqlite";

export type Listing = { policy: string; name: string; listed: boolean };
export type PendingRow = {
  id: string; policy: string; kind: string; title: string; cbor: string; body_hash: string; recipe: string | null; required: string;
  created_by: string; created_at: number; status: string; tx_hash: string | null; error: string | null; unit: string | null;
  attempts: number; updated_at: number;
};

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("create table if not exists vaults (policy text primary key, name text not null, listed integer not null default 0)");
  db.exec("create table if not exists sessions (token_hash text primary key, pkh text not null, expires_at integer not null)");
  const putSession = db.prepare("insert into sessions (token_hash, pkh, expires_at) values (?, ?, ?)");
  const getSession = db.prepare("select pkh, expires_at from sessions where token_hash = ?");
  const purgeSessions = db.prepare("delete from sessions where expires_at < ?");
  // Which vaults each key added to its app: the inbox only shows those.
  db.exec("create table if not exists user_vaults (pkh text not null, policy text not null, vault_id text not null, primary key (pkh, policy))");
  const addUserVault = db.prepare("insert into user_vaults (pkh, policy, vault_id) values (?, ?, ?) on conflict(pkh, policy) do update set vault_id = excluded.vault_id");
  const userVaults = db.prepare("select policy, vault_id from user_vaults where pkh = ?");
  db.exec(`create table if not exists pending (
    id text primary key, policy text not null, kind text not null, title text not null, cbor text not null,
    body_hash text not null, recipe text, required text not null, created_by text not null, created_at integer not null,
    status text not null, tx_hash text, error text, unit text, attempts integer not null default 0, updated_at integer not null default 0)`);
  db.exec("create table if not exists witnesses (pending_id text not null, key_hash text not null, witness text not null, primary key (pending_id, key_hash))");
  const insPending = db.prepare(
    "insert into pending (id, policy, kind, title, cbor, body_hash, recipe, required, created_by, created_at, status, unit, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
  );
  const getPending = db.prepare("select * from pending where id = ?");
  const byPolicy = db.prepare("select * from pending where policy = ? order by created_at desc limit 200");
  // Rows in vaults this key added, plus the creations it made itself (registered only once they land).
  const mine = db.prepare(
    "select p.* from pending p where p.required like ? and (exists (select 1 from user_vaults u where u.policy = p.policy and u.pkh = ?) or (p.kind = 'create' and p.created_by = ?)) order by p.created_at desc limit 200",
  );
  const known = db.prepare("select policy, min(vault_id) as vault_id from user_vaults group by policy order by policy limit 500");
  const openCount = db.prepare("select count(*) as n from pending where policy = ? and status = 'open'");
  const openBy = db.prepare("select count(*) as n from pending where created_by = ? and status = 'open'");
  const setStatus = db.prepare(
    "update pending set status = ?, tx_hash = coalesce(?, tx_hash), error = ?, updated_at = ?, attempts = attempts + ? where id = ? and status = ?",
  );
  const putWitness = db.prepare("insert or ignore into witnesses (pending_id, key_hash, witness) values (?, ?, ?)");
  const witnessesOf = db.prepare("select key_hash, witness from witnesses where pending_id = ?");
  db.exec("create table if not exists agent_tokens (token_hash text primary key, policy text not null, unit text not null, created_at integer not null)");
  db.exec("create table if not exists labels (policy text not null, unit text not null, name text not null, primary key (policy, unit))");
  const delTokens = db.prepare("delete from agent_tokens where policy = ? and unit = ?");
  const insToken = db.prepare("insert into agent_tokens (token_hash, policy, unit, created_at) values (?, ?, ?, ?)");
  const getToken = db.prepare("select policy, unit from agent_tokens where token_hash = ?");
  const putLabel = db.prepare("insert into labels (policy, unit, name) values (?, ?, ?) on conflict(policy, unit) do update set name = excluded.name");
  const labelsOf = db.prepare("select unit, name from labels where policy = ?");
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
    putSession(hash: string, pkh: string, expiresAt: number, now: number) {
      purgeSessions.run(now);
      putSession.run(hash, pkh, expiresAt);
    },
    addUserVault: (pkh: string, policy: string, vaultId: string) => void addUserVault.run(pkh, policy, vaultId),
    userVaults: (pkh: string) => (userVaults.all(pkh) as { policy: string; vault_id: string }[]).map((r) => ({ policy: r.policy, vaultId: r.vault_id })),
    getSession(hash: string): { pkh: string; expiresAt: number } | undefined {
      const r = getSession.get(hash) as { pkh: string; expires_at: number } | undefined;
      return r ? { pkh: r.pkh, expiresAt: r.expires_at } : undefined;
    },
    insertPending(r: { id: string; policy: string; kind: string; title: string; cbor: string; bodyHash: string; recipe: unknown; required: string[]; createdBy: string; createdAt: number; unit?: string }) {
      insPending.run(r.id, r.policy, r.kind, r.title, r.cbor, r.bodyHash, JSON.stringify(r.recipe ?? null), JSON.stringify(r.required), r.createdBy, r.createdAt, r.unit ?? null, r.createdAt);
    },
    getPending: (id: string) => getPending.get(id) as PendingRow | undefined,
    pendingFor: (policy: string) => byPolicy.all(policy) as PendingRow[],
    /** Rows in the vaults this key added, where it is a required signer, plus its own creations. */
    pendingForSigner: (pkh: string) => mine.all(`%"${pkh}"%`, pkh, pkh) as PendingRow[],
    /** Every vault someone added here (bounded), with one id for it. */
    knownVaults: () => (known.all() as { policy: string; vault_id: string }[]).map((r) => ({ policy: r.policy, vaultId: r.vault_id })),
    openCount: (policy: string) => (openCount.get(policy) as { n: number }).n,
    openBy: (pkh: string) => (openBy.get(pkh) as { n: number }).n,
    /** Compare-and-set: only one caller moves a row out of `from`. A move back to open counts an attempt. */
    setStatus: (id: string, from: string, to: string, at: number, o: { txHash?: string; error?: string | null } = {}) =>
      setStatus.run(to, o.txHash ?? null, o.error ?? null, at, from === "submitting" && to === "open" ? 1 : 0, id, from).changes === 1,
    putWitness: (id: string, keyHash: string, witness: string) => void putWitness.run(id, keyHash, witness),
    witnessesOf: (id: string) => witnessesOf.all(id) as { key_hash: string; witness: string }[],
    rotateAgentToken(hash: string, policy: string, unit: string, at: number) {
      delTokens.run(policy, unit);
      insToken.run(hash, policy, unit, at);
    },
    agentOfToken: (hash: string) => getToken.get(hash) as { policy: string; unit: string } | undefined,
    putLabel: (policy: string, unit: string, name: string) => void putLabel.run(policy, unit, name),
    labelsOf: (policy: string): Record<string, string> =>
      Object.fromEntries((labelsOf.all(policy) as { unit: string; name: string }[]).map((r) => [r.unit, r.name])),
  };
}
