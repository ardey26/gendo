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
