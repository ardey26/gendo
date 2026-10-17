// server/test/agent-relay.test.ts — an agent connected by pairing: its status, its token, and the submit
// relay that sends only its own allowance spend, against real txs from the emulator.
import { describe, expect, it } from "vitest";
import { CML, Emulator, Lucid } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { buildAgentSpend, buildOverLimitSpend } from "../../sdk/src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../sdk/src/core/chain.js";
import { witness } from "../../sdk/src/core/cosign.js";
import * as owner from "../../sdk/src/core/owner.js";
import { pairingMessage, signMessage, statusMessage } from "../../sdk/src/core/pairing.js";
import { formatVaultId } from "../../sdk/src/core/vault.js";
import { ADA, collateralOf, party, signAndSubmit } from "../../sdk/test/helpers.js";
import { createApp } from "../src/app.js";
import { json, signIn, store } from "./helpers.js";

describe("an agent connected by pairing", async () => {
  const HOUR = 3_600_000n;
  const [a, agent, other, payee] = [party(2_000n * ADA), party(10n * ADA), party(10n * ADA), party(2n * ADA)];
  const emulator = new Emulator([a, agent, other, payee]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(a.privateKey);
  const created = await owner.createVault(lucid, { owners: [a.pkh], threshold: 1n, paused: false, maxTxValidityMs: HOUR });
  const vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 300n * ADA }), [a]);
  const grant = async (k: typeof agent) => {
    const now = BigInt(emulator.now());
    const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault),
      { agent: k.pkh, destinations: [payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
        periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 60n * ADA } },
      [a.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) });
    await signAndSubmit(lucid, emulator, g.tx, [a]);
    return g.unit;
  };
  const unit = await grant(agent);
  const otherUnit = await grant(other);
  /** A fully signed spend by `k` of allowance `u` (an escalation when `over`). */
  const signed = async (k: typeof agent, u: string, over = false) => {
    const collateral = await collateralOf(lucid, k);
    lucid.selectWallet.fromAddress(k.address, [collateral]);
    const common = {
      lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, u), now: emulator.now(),
      payments: [{ to: payee.address, assets: { lovelace: (over ? 15n : 3n) * ADA } }], intentId: `I-${Math.random()}`, purpose: "p",
    };
    const built = over ? await buildOverLimitSpend({ ...common, cosigners: [a.pkh] }) : await buildAgentSpend(common);
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const cbor = built.tx.toCBOR();
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const ws = CML.TransactionWitnessSetBuilder.new();
    ws.add_existing(tx.witness_set());
    ws.add_existing(CML.TransactionWitnessSet.from_cbor_hex(await witness(lucid, cbor, k.privateKey)));
    return CML.Transaction.new(tx.body(), ws.build(), true, tx.auxiliary_data()).to_cbor_hex();
  };
  const t = Date.now();
  const submitted: string[] = [];
  const db = store();
  const app = createApp({
    store: db, now: () => t, network: "Custom",
    upstream: async () => new Response("{}", { status: 404 }),
    owners: async (p) => (p === vault.hash ? [a.pkh] : undefined),
    allowanceOf: async (p, u) => {
      const al = await readAllowance(lucid, vault, u);
      return { ref: `${al.utxo.txHash}#${al.utxo.outputIndex}`, agent: al.datum.agent };
    },
    allowanceForAgent: async (p, k) => (p === vault.hash && k === agent.pkh ? { unit, ref: "" } : undefined),
    submit: async (cbor) => (submitted.push(cbor), { ok: true as const, hash: "h1" }),
  });
  const ownerTok = ((await (await signIn(app, { sk: a.privateKey, pkh: a.pkh, addressHex: CML.Address.from_bech32(a.address).to_hex() })).json()) as { token: string }).token;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers: json(headers), ...(body ? { body: JSON.stringify(body) } : {}) });
  const vaultId = formatVaultId({ network: "Custom", seed: vault.seed });
  const owners = { authorization: `Bearer ${ownerTok}` };
  await call("POST", "/me/vaults", owners, { vaultId });
  const p = (await (await call("POST", `/vaults/${vault.hash}/pairings`, owners, { name: "My Claude" })).json()) as { id: string; code: string };
  await call("POST", "/pairings/claim", {}, { code: p.code, ...signMessage(agent.privateKey, pairingMessage(p.code)) });
  const status = async (ms = t, k = agent) => (await call("POST", "/agent/status", {}, { ms, ...signMessage(k.privateKey, statusMessage(ms)) })).json() as Promise<Record<string, string>>;

  it("is not ready until the owners confirm, then gets its vault, allowance, token and name", async () => {
    expect((await status()).status).toBe("claimed");
    await call("POST", `/pairings/${p.id}/confirm`, owners);
    const r = await status();
    expect(r).toMatchObject({ status: "ready", vaultId, unit, name: "My Claude" });
    expect(r.token).toMatch(/^gnd_[0-9a-f]{64}$/);
    expect(db.labelsOf(vault.hash)[unit]).toBe("My Claude");
  });
  it("refuses a stale status signature", async () => {
    const old = t - 6 * 60_000;
    expect((await call("POST", "/agent/status", {}, { ms: old, ...signMessage(agent.privateKey, statusMessage(old)) })).status).toBe(401);
  });
  it("a key with no pairing is unknown", async () => expect((await status(t, payee)).status).toBe("unknown"));
  it("relays the agent's own allowance spend, and nothing else", async () => {
    const { token } = await status();
    const post = async (cbor: string, pid = token!) => app.request("/chain/tx/submit", { method: "POST", headers: { project_id: pid, "content-type": "application/cbor" }, body: Buffer.from(cbor, "hex") });
    const ok = await post(await signed(agent, unit));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toBe("h1");
    expect((await post(await signed(other, otherUnit))).status).toBe(403); // another agent's allowance
    expect((await post(await signed(agent, unit, true))).status).toBe(403); // an escalation goes through the inbox
    expect((await post("00", "gnd_" + "0".repeat(64))).status).toBe(401);
    expect(submitted).toHaveLength(1);
  });
});
