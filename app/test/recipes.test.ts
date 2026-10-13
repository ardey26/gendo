import { describe, expect, it } from "vitest";
import { decodeRecipe, encodeRecipe, type Recipe } from "../src/owner/recipes.ts";

describe("recipes", () => {
  it("round-trip through JSON with bigints intact", () => {
    const [a, b] = ["a".repeat(56), "b".repeat(56)];
    const r: Recipe = { op: "config", owners: [a, b], threshold: 2n, signers: [a, b] };
    expect(decodeRecipe(JSON.parse(JSON.stringify(encodeRecipe(r))))).toEqual(r);
  });
  it("refuses anything that isn't a recipe", () => {
    for (const x of [null, 5, { op: "steal" }, { op: "unpause" }]) expect(decodeRecipe(x)).toBeUndefined();
  });
});
