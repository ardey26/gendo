// TEST BUILDS ONLY: a CIP-30 wallet backed by a key from ?testwallet=<ed25519_sk…>, for the
// headless end-to-end test. Never present in a production build.
import { CML, type LucidEvolution } from "../../../sdk/src/core/index.ts";
import { signData } from "../../../sdk/src/node/auth.ts";
import type { Cip30 } from "./wallet.ts";

export function installTestWallet(lucid: LucidEvolution) {
  const fromUrl = new URLSearchParams(location.search).get("testwallet");
  try {
    if (fromUrl) sessionStorage.setItem("gendo.testkey", fromUrl);
  } catch {
    // private mode: the URL key still works for this page
  }
  let key = fromUrl;
  try {
    key = key ?? sessionStorage.getItem("gendo.testkey");
  } catch {
    // ignore
  }
  if (!key) return;
  const sk = CML.PrivateKey.from_bech32(key);
  const pkh = sk.to_public().hash().to_hex();
  const addr = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address();
  const bech = addr.to_bech32();
  const hex = addr.to_hex();
  const api: Cip30 = {
    getNetworkId: async () => 0,
    getUsedAddresses: async () => [hex],
    getUnusedAddresses: async () => [],
    getChangeAddress: async () => hex,
    getRewardAddresses: async () => [],
    getUtxos: async () =>
      (await lucid.utxosAt(bech)).map((u) =>
        CML.TransactionUnspentOutput.new(
          CML.TransactionInput.new(CML.TransactionHash.from_hex(u.txHash), BigInt(u.outputIndex)),
          CML.TransactionOutput.new(CML.Address.from_bech32(u.address), CML.Value.from_coin(u.assets.lovelace ?? 0n)),
        ).to_cbor_hex(),
      ),
    getCollateral: async () => [],
    getBalance: async () => CML.Value.from_coin(0n).to_cbor_hex(),
    signTx: async (cbor) => {
      const body = CML.Transaction.from_cbor_hex(cbor).body();
      const ws = CML.TransactionWitnessSetBuilder.new();
      ws.add_vkey(CML.make_vkey_witness(CML.hash_transaction(body), sk));
      return ws.build().to_cbor_hex();
    },
    signData: async (address, payload) => signData(address, payload, key!),
    submitTx: async () => {
      throw new Error("the test wallet doesn't submit; txs go through the inbox");
    },
  };
  const g = globalThis as unknown as { cardano?: Record<string, unknown> };
  g.cardano = { ...(g.cardano ?? {}), gendotest: { name: "Test wallet", apiVersion: "0.1.0", enable: async () => api, isEnabled: async () => true } };
}
