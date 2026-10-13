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
