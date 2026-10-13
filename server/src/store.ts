// server/src/store.ts
// Public listings: a vault's display name and whether it may be indexed.
// Everything else the public page shows comes from the chain.
import { DatabaseSync } from "node:sqlite";

export type Listing = { policy: string; name: string; listed: boolean };

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("create table if not exists vaults (policy text primary key, name text not null, listed integer not null default 0)");
  db.exec("create table if not exists sessions (token_hash text primary key, pkh text not null, expires_at integer not null)");
  const putSession = db.prepare("insert into sessions (token_hash, pkh, expires_at) values (?, ?, ?)");
  const getSession = db.prepare("select pkh, expires_at from sessions where token_hash = ?");
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
  };
}
