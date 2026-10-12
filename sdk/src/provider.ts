// Provider/network setup shared by the CLI and demo.
import { Blockfrost, Lucid, SLOT_CONFIG_NETWORK, type LucidEvolution, type Network } from "@lucid-evolution/lucid";
import { assertTestNetwork } from "./vault.js";

export type ProviderConfig = {
  network: Network; // "Preprod" or "Custom" (local devnet)
  blockfrostUrl: string;
  blockfrostProjectId: string;
  /** Local devnets only: Yaci admin API (slot config) and Ogmios (raw cost models). */
  devnet?: { adminUrl: string; ogmiosUrl?: string };
};

export function providerFromEnv(env = process.env): ProviderConfig {
  const network = (env.VAULT_NETWORK ?? "Preprod") as Network;
  assertTestNetwork(network);
  if (network === "Preprod") {
    const id = env.BLOCKFROST_PROJECT_ID;
    if (!id) throw new Error("BLOCKFROST_PROJECT_ID is required for Preprod");
    if (!id.startsWith("preprod")) throw new Error("BLOCKFROST_PROJECT_ID is not a preprod project id (edge I5)");
    return { network, blockfrostUrl: env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0", blockfrostProjectId: id };
  }
  return {
    network,
    blockfrostUrl: env.BLOCKFROST_URL ?? "http://localhost:8080/api/v1",
    blockfrostProjectId: env.BLOCKFROST_PROJECT_ID ?? "devnet",
    devnet: { adminUrl: env.YACI_ADMIN ?? "http://localhost:10000/local-cluster/api", ogmiosUrl: env.YACI_OGMIOS ?? "ws://localhost:1337" },
  };
}

async function ogmiosCostModels(url: string): Promise<Record<string, number[]> | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => resolve(undefined), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/protocolParameters", id: 1 }));
    ws.onmessage = (m) => {
      clearTimeout(t);
      const cm = JSON.parse(String(m.data)).result.plutusCostModels;
      ws.close();
      resolve({ PlutusV1: cm["plutus:v1"], PlutusV2: cm["plutus:v2"], PlutusV3: cm["plutus:v3"] });
    };
    ws.onerror = () => resolve(undefined);
  });
}

/**
 * Retry transient network failures ("fetch failed"), observed against public
 * preprod endpoints. Resubmitting the same signed tx is harmless: a tx can
 * only land once.
 */
let retrying = false;
function installFetchRetry() {
  if (retrying) return;
  retrying = true;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    for (let i = 0; ; i++) {
      try {
        return await orig(input, init);
      } catch (e) {
        if (i >= 4 || !(e instanceof TypeError)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
  }) as typeof fetch;
}

/** A provider failure worth retrying: a timeout, a dropped connection or a gateway error. */
export const isTransient = (e: unknown) =>
  /TimeoutError|aborted due to timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b50[234]\b/.test(String((e as Error)?.message ?? e));

/** Provider calls that only read, so repeating one is always safe. */
const READS = new Set(["getProtocolParameters", "getUtxos", "getUtxosWithUnit", "getUtxoByUnit", "getUtxosByOutRef", "getDelegation", "getDatum", "evaluateTx"]);

/**
 * Retry read calls that fail transiently. Lucid gives up on a single request
 * after 30 s, and on preprod Blockfrost has stalled past that, failing whole
 * flows. Submissions are not retried here: a submit that timed out may have
 * landed, and the fate check in idempotency.ts decides that.
 */
export function withRetries<P extends object>(provider: P, opts: { attempts?: number; baseMs?: number } = {}): P {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 2000;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || !READS.has(String(prop))) return v;
      return async (...args: unknown[]) => {
        for (let i = 0; ; i++) {
          try {
            return await v.apply(target, args);
          } catch (e) {
            if (i >= attempts - 1 || !isTransient(e)) throw e;
            await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
          }
        }
      };
    },
  });
}

export async function connect(cfg: ProviderConfig): Promise<LucidEvolution> {
  installFetchRetry();
  if (cfg.devnet) {
    const devnet = await (await fetch(`${cfg.devnet.adminUrl}/admin/devnet`)).json();
    SLOT_CONFIG_NETWORK.Custom = { zeroTime: devnet.startTime * 1000, zeroSlot: 0, slotLength: devnet.slotLength * 1000 };
    // Some devnet indexers omit `cost_models_raw`; take the node's arrays from Ogmios.
    const raw = cfg.devnet.ogmiosUrl ? await ogmiosCostModels(cfg.devnet.ogmiosUrl) : undefined;
    if (raw) {
      const orig = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const res = await orig(input, init);
        if (!String(input).endsWith("/epochs/latest/parameters")) return res;
        const body = await res.json();
        if (!body.cost_models_raw) body.cost_models_raw = raw;
        return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
      }) as typeof fetch;
    }
  }
  const lucid = await Lucid(withRetries(new Blockfrost(cfg.blockfrostUrl, cfg.blockfrostProjectId)), cfg.network);
  // Edge I5: the provider must agree on the network.
  if (cfg.network === "Preprod") {
    const r = await fetch(`${cfg.blockfrostUrl}/genesis`, { headers: { project_id: cfg.blockfrostProjectId } });
    if (!r.ok) throw new Error(`provider check failed: ${r.status}`);
    const genesis = await r.json();
    if (genesis.network_magic !== 1) throw new Error(`provider network magic ${genesis.network_magic} is not preprod (1)`);
  }
  return lucid;
}
