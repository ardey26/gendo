// sdk/test/unit/read.test.ts
import { describe, expect, it } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import { asBytes, asConstr, asInt, asList, decodePlutusData, type PData } from "../../src/read/plutus-cbor.js";

// The reference: Lucid's own encoder. The decoder must read exactly what the SDK writes.
const toPlain = (d: PData): unknown =>
  d.k === "constr" ? { c: d.index, f: d.fields.map(toPlain) }
  : d.k === "int" ? d.v.toString()
  : d.k === "bytes" ? d.hex
  : d.k === "list" ? d.items.map(toPlain)
  : d.entries.map(([a, b]) => [toPlain(a), toPlain(b)]);
const lucidPlain = (x: Data): unknown =>
  x instanceof Constr ? { c: x.index, f: x.fields.map(lucidPlain) }
  : typeof x === "bigint" ? x.toString()
  : typeof x === "string" ? x
  : Array.isArray(x) ? x.map(lucidPlain)
  : [...(x as Map<Data, Data>).entries()].map(([a, b]) => [lucidPlain(a), lucidPlain(b)]);

describe("decodePlutusData", () => {
  const cases: Data[] = [
    0n, 23n, 24n, 255n, 65_535n, 4_294_967_296n, -1n, -500n,
    2n ** 64n + 5n, -(2n ** 70n), 10n ** 30n,
    "", "ab", "00".repeat(28), "ff".repeat(64), "ee".repeat(65), "cd".repeat(200),
    [], [1n, 2n], new Constr(0, []), new Constr(1, ["ab", 5n]), new Constr(6, [[]]),
    new Constr(7, [1n]), new Constr(127, []), new Constr(128, [9n]),
    new Map<Data, Data>([[1n, "aa"], ["bb", new Constr(0, [])]]),
    new Constr(0, [["aa", "bb"], 2n, new Constr(1, []), 600_000n]),
  ];
  for (const x of cases)
    it(`reads ${Data.to(x).slice(0, 24)}… like Lucid`, () => expect(toPlain(decodePlutusData(Data.to(x)))).toEqual(lucidPlain(x)));

  it("rejects trailing bytes and truncated input", () => {
    expect(() => decodePlutusData(Data.to(5n) + "00")).toThrow(/trailing/);
    expect(() => decodePlutusData("9f01")).toThrow(/end of input/);
  });

  it("accessors check the shape", () => {
    const d = decodePlutusData(Data.to(new Constr(1, [7n, "ab", [1n]])));
    const [i, b, l] = asConstr(d, 1, 3);
    expect([asInt(i!), asBytes(b!), asList(l!).length]).toEqual([7n, "ab", 1]);
    expect(() => asConstr(d, 0)).toThrow(/constructor 0/);
    expect(() => asInt(b!)).toThrow(/integer/);
  });
});

import { allowanceToData, configToData, type AllowanceDatum, type PlutusAddress } from "../../src/core/data.js";
import { fromPlutusAddress } from "../../src/core/address.js";
import { makeVault } from "../../src/core/vault.js";
import { addressToBech32, allowanceFromCbor, configFromCbor, scriptAddress } from "../../src/read/decode.js";

const h = (n: number) => n.toString(16).padStart(2, "0").repeat(28);

describe("datums without Lucid", () => {
  it("reads a config like the SDK writes it", () => {
    const cfg = { owners: [h(1), h(2), h(3)], threshold: 2n, paused: true, maxTxValidityMs: 600_000n };
    expect(configFromCbor(configToData(cfg))).toEqual(cfg);
  });
  it("reads an allowance like the SDK writes it", () => {
    const a: AllowanceDatum = {
      agent: h(9),
      destinations: [
        { payment: { type: "Key", hash: h(4) }, stake: null },
        { payment: { type: "Key", hash: h(5) }, stake: { type: "Key", hash: h(6) } },
        { payment: { type: "Key", hash: h(7) }, stake: { pointer: [1n, 2n, 3n] } },
      ],
      caps: [{ policy: "", name: "", windowCap: 25_000_000n, txCap: 10_000_000n }, { policy: h(8), name: "746f6b", windowCap: 100n, txCap: 10n }],
      spent: [3_000_000n, 0n],
      windowStart: 1_790_000_000_000n,
      periodMs: 86_400_000n,
      expiresAt: 1_800_000_000_000n,
      maxFee: 1_000_000n,
    };
    expect(allowanceFromCbor(allowanceToData(a))).toEqual(a);
  });
  it("rejects a datum of the wrong shape", () => {
    expect(() => allowanceFromCbor(configToData({ owners: [h(1)], threshold: 1n, paused: false, maxTxValidityMs: 1n }))).toThrow();
  });
});

describe("addresses without Lucid", () => {
  const forms: PlutusAddress[] = [
    { payment: { type: "Key", hash: h(4) }, stake: null },
    { payment: { type: "Key", hash: h(4) }, stake: { type: "Key", hash: h(5) } },
    { payment: { type: "Key", hash: h(4) }, stake: { type: "Script", hash: h(5) } },
    { payment: { type: "Script", hash: h(4) }, stake: { type: "Key", hash: h(5) } },
    { payment: { type: "Script", hash: h(4) }, stake: null },
  ];
  for (const a of forms)
    it(`matches Lucid for ${a.payment.type}/${a.stake === null ? "none" : "pointer" in a.stake ? "pointer" : a.stake.type}`, () =>
      expect(addressToBech32(a, "Preprod")).toBe(fromPlutusAddress("Preprod", a)));
  // The SDK refuses pointer addresses, so the reference is CIP-19's own test vector.
  it("encodes a pointer address like the CIP-19 test vector", () =>
    expect(
      addressToBech32({ payment: { type: "Key", hash: "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e" }, stake: { pointer: [2_498_243n, 27n, 3n] } }, "Preprod"),
    ).toBe("addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrdw5vky"));
  it("derives the vault address from its policy id", () => {
    const v = makeVault("Preprod", { txHash: "11".repeat(32), outputIndex: 0 });
    expect(scriptAddress(v.hash, "Preprod")).toBe(v.address);
  });
});

import { allowanceHistory, readVault, type Get } from "../../src/read/chain.js";
import { utf8ToHex } from "../../src/core/bytes.js";

describe("vault state from the chain", () => {
  const policy = h(0x0a);
  const addr = scriptAddress(policy, "Preprod");
  const cfg = { owners: [h(1), h(2), h(3)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n };
  const unitA = policy + h(0x0b);
  const day = 86_400_000n;
  const allowance = (spent: bigint, windowStart: bigint): AllowanceDatum => ({
    agent: h(9),
    destinations: [{ payment: { type: "Key", hash: h(4) }, stake: null }],
    caps: [{ policy: "", name: "", windowCap: 25_000_000n, txCap: 10_000_000n }],
    spent: [spent],
    windowStart,
    periodMs: day,
    expiresAt: windowStart + 30n * day,
    maxFee: 1_000_000n,
  });
  const utxo = (tx: string, units: Record<string, string>, datum: string | null) => ({
    tx_hash: tx, output_index: 0, inline_datum: datum,
    amount: Object.entries(units).map(([unit, quantity]) => ({ unit, quantity })),
  });
  const fakeGet = (utxos: unknown[]): Get => async (path) => (path.startsWith(`/addresses/${addr}/utxos`) ? (path.includes("page=1") ? utxos : []) : undefined);
  const t0 = 1_790_000_000_000n;
  const cfgUtxo = utxo("c0".repeat(32), { lovelace: "2000000", [policy + utf8ToHex("config")]: "1" }, configToData(cfg));

  it("reads config, treasury and an allowance with its budget", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(3_000_000n, t0))), utxo("e0".repeat(32), { lovelace: "150000000" }, null)]), policy, "Preprod", Number(t0 + 3_600_000n));
    expect(v!.config).toEqual(cfg);
    expect(v!.treasuryLovelace).toBe(150_000_000n);
    const a = v!.allowances[0]!;
    expect(a.status).toBe("active");
    expect(a.caps[0]).toMatchObject({ unit: "lovelace", perPayment: 10_000_000n, perPeriod: 25_000_000n, spentThisPeriod: 3_000_000n, leftThisPeriod: 22_000_000n });
    expect(a.payees).toEqual([addressToBech32({ payment: { type: "Key", hash: h(4) }, stake: null }, "Preprod")]);
  });
  it("a period that rolled over shows nothing spent this period", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(9_000_000n, t0)))]), policy, "Preprod", Number(t0 + 2n * day + 5n));
    expect(v!.allowances[0]!.caps[0]!.spentThisPeriod).toBe(0n);
    expect(v!.allowances[0]!.periodEndsAt).toBe(Number(t0 + 3n * day));
  });
  it("past expiry reads expired", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(0n, t0)))]), policy, "Preprod", Number(t0 + 31n * day));
    expect(v!.allowances[0]!.status).toBe("expired");
  });
  it("a malformed allowance is reported, not fatal", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "5000000", [unitA]: "1" }, "d87980")]), policy, "Preprod", Number(t0));
    expect(v!.allowances[0]!.status).toBe("malformed");
  });
  it("a vault with no allowances has an empty list", async () => {
    const v = await readVault(fakeGet([cfgUtxo]), policy, "Preprod", Number(t0));
    expect(v!.allowances).toEqual([]);
  });
  it("nothing at the address is no vault", async () => {
    expect(await readVault(async () => undefined, policy, "Preprod", Number(t0))).toBeUndefined();
  });

  it("walks an allowance's history back to its grant, with each intent's purpose", async () => {
    const payee = addressToBech32({ payment: { type: "Key", hash: h(4) }, stake: null }, "Preprod");
    const intent = { v: 1, id: "INV-1", kind: "agent_spend", purpose: "hosting" };
    const j = JSON.stringify(intent).match(/.{1,64}/g)!;
    const get: Get = async (path) => {
      if (path === "/txs/" + "b2".repeat(32) + "/utxos")
        return { inputs: [{ tx_hash: "b1".repeat(32), output_index: 0, amount: [{ unit: unitA, quantity: "1" }] }], outputs: [{ address: payee, amount: [{ unit: "lovelace", quantity: "4000000" }] }, { address: addr, amount: [{ unit: unitA, quantity: "1" }] }] };
      if (path === "/txs/" + "b2".repeat(32) + "/metadata") return [{ label: "7041", json_metadata: { h: "00", j } }];
      if (path === "/txs/" + "b2".repeat(32)) return { block_time: 1_790_000_100 };
      if (path === "/txs/" + "b1".repeat(32) + "/utxos") return { inputs: [{ tx_hash: "ff".repeat(32), output_index: 0, amount: [{ unit: "lovelace", quantity: "9" }] }], outputs: [] };
      return undefined;
    };
    const hist = await allowanceHistory(get, unitA, addr, "b2".repeat(32));
    expect(hist).toEqual([{ txHash: "b2".repeat(32), time: 1_790_000_100_000, kind: "agent", purpose: "hosting", intentId: "INV-1", payees: [{ address: payee, lovelace: 4_000_000n }] }]);
  });
});
