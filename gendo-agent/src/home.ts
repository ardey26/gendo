// Where a connection lives on this machine: its key (made here, never sent anywhere) and its state.
// One folder per pairing code, so an app that restarts with the same --pair code finds the same key.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CML, generatePrivateKey } from "../../sdk/src/core/index.js";

export type Ready = { vaultId: string; unit: string; token: string };
export type State = { code: string; server: string; claimed?: boolean; ready?: Ready };

export const normCode = (code: string) => code.trim().toUpperCase();

export function openHome(home: string, code: string, server: string) {
  const c = normCode(code);
  const dir = join(home, createHash("sha256").update(c).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "agent.sk");
  const statePath = join(dir, "state.json");
  if (!existsSync(keyPath)) writeFileSync(keyPath, generatePrivateKey() + "\n", { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const sk = readFileSync(keyPath, "utf8").trim();
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const h = {
    dir,
    sk,
    pkh,
    state: (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { code: c, server }) as State,
    save(next: Partial<State>) {
      h.state = { ...h.state, ...next };
      writeFileSync(statePath, JSON.stringify(h.state, null, 2), { mode: 0o600 });
    },
  };
  return h;
}
export type Home = ReturnType<typeof openHome>;
