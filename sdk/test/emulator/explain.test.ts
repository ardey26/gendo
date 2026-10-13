// sdk/test/emulator/explain.test.ts
// explainTx must say exactly what each owner/escalation tx does, from the tx and its inputs alone.
import { beforeAll, describe, expect, it } from "vitest";
import type { Emulator, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { buildOverLimitSpend } from "../../src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../src/core/chain.js";
import { describeTx } from "../../src/core/cosign.js";
import { explainTx } from "../../src/core/explain.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../helpers.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
let unit: string;
const HOUR = 3_600_000n;

const inputsOf = async (cbor: string): Promise<UTxO[]> =>
  lucid.utxosByOutRef(describeTx(cbor).inputs.map((r) => ({ txHash: r.split("#")[0]!, outputIndex: Number(r.split("#")[1]) })));
const explain = async (cbor: string) => explainTx(cbor, vault, await inputsOf(cbor));

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 500n * ADA }), [w.a]);
  const now = BigInt(emulator.now());
  const granted = await owner.grantAllowance(
    lucid, vault, await readConfig(lucid, vault),
    { agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 100n * ADA } },
    [w.a.pkh, w.b.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) },
  );
  unit = granted.unit;
  await signAndSubmit(lucid, emulator, granted.tx, [w.a, w.b]);
}, 120_000);

describe("explainTx", () => {
  it("an edit: the allowance before and after, nothing leaves the vault", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const al = await readAllowance(lucid, vault, unit);
    const next = { ...al.datum, caps: [{ ...al.datum.caps[0]!, txCap: 5n * ADA }] };
    const tx = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, next, [w.a.pkh, w.c.pkh]);
    const e = await explain(tx.toCBOR());
    expect(e.changes).toEqual([{ kind: "edit", unit, before: al.datum, after: next, lovelaceBefore: 100n * ADA, lovelaceAfter: 100n * ADA }]);
    expect(e.leavesVault).toBe(0n);
    expect(e.requiredSigners.sort()).toEqual([w.a.pkh, w.c.pkh].sort());
    expect(e.warnings).toEqual([]);
  });

  it("a single-owner pause: the config before and after", async () => {
    const cfg = await readConfig(lucid, vault);
    const e = await explain((await owner.pause(lucid, vault, cfg, [w.a.pkh])).toCBOR());
    expect(e.changes).toEqual([{ kind: "config", before: cfg.config, after: { ...cfg.config, paused: true } }]);
    expect(e.requiredSigners).toEqual([w.a.pkh]);
    expect(e.ttlSlot).toBeTypeOf("number");
  });

  it("a revoke returns the funds to the vault", async () => {
    const al = await readAllowance(lucid, vault, unit);
    const e = await explain((await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), al, [w.a.pkh, w.b.pkh])).toCBOR());
    expect(e.changes).toEqual([{ kind: "revoke", unit, before: al.datum, lovelace: 100n * ADA }]);
    expect(e.leavesVault).toBe(0n);
  });

  it("a treasury payment shows exactly what leaves the vault and to whom", async () => {
    const from = await treasuryUtxos(lucid, vault);
    const tx = await owner.treasuryPay(lucid, vault, await readConfig(lucid, vault), from, [{ to: w.stranger.address, assets: { lovelace: 7n * ADA } }], [w.a.pkh, w.b.pkh]);
    const e = await explain(tx.toCBOR());
    expect(e.changes).toEqual([]);
    expect(e.leavesVault).toBe(7n * ADA);
    expect(e.outside).toContainEqual({ address: w.stranger.address, lovelace: 7n * ADA });
  });

  it("an escalation: a co-signed spend of the allowance, with its intent", async () => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    const built = await buildOverLimitSpend({
      lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now(),
      payments: [{ to: w.stranger.address, assets: { lovelace: 40n * ADA } }],
      intentId: "INV-9", purpose: "vendor prepayment", cosigners: [w.a.pkh, w.c.pkh],
    });
    const e = await explain(built.tx.toCBOR());
    expect(e.changes).toHaveLength(1);
    expect(e.changes[0]).toMatchObject({ kind: "spend", unit, redeemer: "CoSignedSpend" });
    expect(e.intent).toMatchObject({ id: "INV-9", purpose: "vendor prepayment" });
    expect(e.outside).toContainEqual({ address: w.stranger.address, lovelace: 40n * ADA });
    expect(e.leavesVault).toBeGreaterThanOrEqual(40n * ADA); // the fee comes out of the allowance too
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  });

  it("warns when it can't see an input, so nothing unseen gets signed", async () => {
    const cfg = await readConfig(lucid, vault);
    const cbor = (await owner.pause(lucid, vault, cfg, [w.a.pkh])).toCBOR();
    const e = explainTx(cbor, vault, []);
    expect(e.warnings.join(" ")).toMatch(/couldn't see/);
  });
});
