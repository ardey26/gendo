// Signer daemon: the only process that holds the agent key (edge O1).
// Listens on a Unix socket (mode 0600). The agent/LLM process POSTs unsigned
// tx CBOR; the daemon applies `policy.evaluate` and returns only a witness set.
// Every decision is appended to an audit log.
//
// Before policy limits, every tx must carry an intent record that matches its
// redeemer hash, and its intent id goes through the dedupe rule (dedupe.ts).
// Counters and the intent table persist in `statePath` and are saved before a
// witness is released, so restarts don't reset limits or forget intents.
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { CML } from "@lucid-evolution/lucid";
import type { ChainQuery } from "../../core/idempotency.js";
import { createSigner } from "./core.js";
import type { SignerPolicy } from "./policy.js";

export type SignerOptions = {
  socketPath: string;
  privateKey: string; // bech32 ed25519 private key; loaded by the caller from a 0600 file
  policy: SignerPolicy;
  auditLog?: string;
  /** JSON file for counters + intent table. Without it, state is in memory only (tests). */
  statePath?: string;
  /** Lets the signer decide whether an earlier tx for the same intent landed. Without it, a
   *  different tx for a known intent is refused until it can be proven dead. */
  chain?: ChainQuery;
  now?: () => number;
  /**
   * Socket permissions. 0o600 (default): only the signer's own OS user can
   * connect. 0o660: members of the socket's group can too, so the signer can run
   * as a separate user whose key file the agent can't read.
   */
  socketMode?: 0o600 | 0o660;
};

export { witnessFor } from "./core.js";

export function startSigner(opts: SignerOptions): Promise<Server> {
  const socketMode = opts.socketMode ?? 0o600;
  if (socketMode !== 0o600 && socketMode !== 0o660) throw new Error("socketMode must be 0o600 or 0o660");
  const sk = CML.PrivateKey.from_bech32(opts.privateKey);
  const pkh = sk.to_public().hash().to_hex();
  if (pkh !== opts.policy.agentKeyHash) throw new Error("private key does not match policy.agentKeyHash");
  const core = createSigner({
    privateKey: opts.privateKey, policy: opts.policy,
    ...(opts.statePath ? { statePath: opts.statePath } : {}), ...(opts.auditLog ? { auditLog: opts.auditLog } : {}),
    ...(opts.chain ? { chain: opts.chain } : {}), ...(opts.now ? { now: opts.now } : {}),
  });

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sign") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      void decide(raw).then(
        ({ status, body }) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e) => res.writeHead(500).end(JSON.stringify({ error: String(e) })),
      );
    });
  });

  async function decide(raw: string): Promise<{ status: number; body: object }> {
    let txCbor = "";
    try {
      txCbor = String(JSON.parse(raw).txCbor ?? "");
    } catch {
      return { status: 400, body: { error: "bad request" } };
    }
    try {
      return { status: 200, body: { witness: await core.sign(txCbor) } };
    } catch (e) {
      const m = (e as Error).message;
      if (m.startsWith("signer refused: ")) return { status: 403, body: { error: m.slice("signer refused: ".length) } };
      throw e;
    }
  }

  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  return new Promise((resolve) =>
    server.listen(opts.socketPath, () => {
      chmodSync(opts.socketPath, socketMode);
      resolve(server);
    }),
  );
}

export function loadPrivateKey(path: string): string {
  return readFileSync(path, "utf8").trim();
}
