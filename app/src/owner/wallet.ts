// CIP-30 browser wallets. Owners sign with partial signing: the wallet adds its own
// signature to a tx other owners also sign.
import { CML } from "../../../sdk/src/core/index.ts";
import { fromHex } from "../../../sdk/src/core/bytes.ts";

export type Cip30 = {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  getUtxos(): Promise<string[] | undefined>;
  getCollateral?(): Promise<string[] | undefined>;
  getBalance(): Promise<string>;
  signTx(tx: string, partial: boolean): Promise<string>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
  submitTx(tx: string): Promise<string>;
};
type Injected = { name?: string; icon?: string; enable(): Promise<Cip30> };
export class WalletError extends Error {
  constructor(readonly code: "NOT_FOUND" | "WRONG_NETWORK" | "DECLINED" | "NO_PARTIAL", message: string) {
    super(message);
  }
}

const injected = (): Record<string, Injected> => (globalThis as unknown as { cardano?: Record<string, Injected> }).cardano ?? {};
const KNOWN = [{ id: "lace", name: "Lace" }, { id: "eternl", name: "Eternl" }, { id: "vespr", name: "Vespr" }];

export type WalletChoice = { id: string; name: string; icon?: string; installed: boolean };
export function wallets(): WalletChoice[] {
  const inj = injected();
  const found = Object.entries(inj)
    .filter(([, w]) => w && typeof w.enable === "function" && typeof w.name === "string")
    .map(([id, w]) => ({ id, name: w.name!, ...(w.icon ? { icon: w.icon } : {}), installed: true }));
  return [...found, ...KNOWN.filter((k) => !inj[k.id]).map((k) => ({ ...k, installed: false }))];
}

/** `keys`: every payment key hash the wallet showed us (an HD wallet signs for all of them). */
export type Connected = { id: string; name: string; api: Cip30; addressHex: string; address: string; pkh: string; keys: string[] };

const keyOfHex = (hex: string) => {
  try {
    return CML.Address.from_raw_bytes(fromHex(hex)).payment_cred()?.as_pub_key()?.to_hex();
  } catch {
    return undefined;
  }
};

export async function connectWallet(id: string): Promise<Connected> {
  const w = injected()[id];
  if (!w) throw new WalletError("NOT_FOUND", "That wallet isn't installed in this browser.");
  let api: Cip30;
  try {
    api = await w.enable();
  } catch {
    throw new WalletError("DECLINED", "The wallet didn't allow the connection.");
  }
  if ((await api.getNetworkId()) !== 0) throw new WalletError("WRONG_NETWORK", "Your wallet is on mainnet. Switch it to Preprod.");
  const addressHex = (await api.getUsedAddresses())[0] ?? (await api.getChangeAddress());
  const a = CML.Address.from_raw_bytes(fromHex(addressHex));
  const pkh = a.payment_cred()?.as_pub_key()?.to_hex();
  if (!pkh) throw new WalletError("NOT_FOUND", "This wallet's address has no payment key.");
  const used = await api.getUsedAddresses().catch(() => [] as string[]);
  const change = await api.getChangeAddress().catch(() => addressHex);
  const utxoAddrs = ((await api.getUtxos().catch(() => undefined)) ?? []).map((u) => {
    try {
      return CML.TransactionUnspentOutput.from_cbor_hex(u).output().address().to_hex();
    } catch {
      return "";
    }
  });
  const keys = [...new Set([pkh, ...[...used, change, ...utxoAddrs].map(keyOfHex).filter((k): k is string => !!k)])];
  return { id, name: w.name ?? id, api, addressHex, address: a.to_bech32(), pkh, keys };
}

export async function partialSign(c: Connected, cbor: string): Promise<string> {
  try {
    return await c.api.signTx(cbor, true);
  } catch (e) {
    const m = String((e as { info?: string })?.info ?? (e as Error)?.message ?? e);
    if (/declin|reject|cancel|refus|denied/i.test(m)) throw new WalletError("DECLINED", "You declined in the wallet. Nothing was signed.");
    throw new WalletError("NO_PARTIAL", `This wallet can't co-sign (no partial signing: ${m.slice(0, 100)}). Try Lace or Eternl.`);
  }
}

/**
 * The wallet's coins, minus any the chain says are already spent. A wallet learns its coins were spent
 * only when its own indexer catches up, and a tx our server submitted (a vault creation, an approval)
 * can leave it listing a spent coin for minutes; a tx built on it fails with BadInputsUTxO.
 * If the chain can't be asked, the wallet's list is used as is.
 */
export function withChainCheckedUtxos(api: Cip30, unspentAt: (address: string) => Promise<{ txHash: string; outputIndex: number }[]>): Cip30 {
  const check = async (list: string[] | undefined) => {
    if (!list?.length) return list;
    try {
      const coins = list.map((cbor) => {
        const u = CML.TransactionUnspentOutput.from_cbor_hex(cbor);
        return { cbor, ref: `${u.input().transaction_id().to_hex()}#${u.input().index()}`, address: u.output().address().to_bech32() };
      });
      const live = new Set<string>();
      for (const address of new Set(coins.map((c) => c.address)))
        for (const u of await unspentAt(address)) live.add(`${u.txHash}#${u.outputIndex}`);
      return coins.filter((c) => live.has(c.ref)).map((c) => c.cbor);
    } catch {
      return list;
    }
  };
  return {
    ...api,
    getUtxos: async () => check(await api.getUtxos()),
    ...(api.getCollateral ? { getCollateral: async () => check(await api.getCollateral!()) } : {}),
  };
}
