// sdk/test/unit/read-bundle.test.ts
// The public page imports sdk/src/read. It must never pull in Lucid or CML
// (about 1.9 MB over the wire): this bundles it with Lucid forbidden.
import { build, type Plugin } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const forbid: Plugin = {
  name: "no-lucid",
  setup(b) {
    b.onResolve({ filter: /^@lucid-evolution|cardano-multiplatform-lib/ }, (a) => ({ errors: [{ text: `light path imports ${a.path}` }] }));
  },
};
const bundle = (entry: string) =>
  build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false, platform: "browser", format: "esm", plugins: [forbid], logLevel: "silent", minify: true });

describe("light read path", () => {
  it("bundles without Lucid, small", async () => {
    const r = await bundle("../../src/read/index.ts");
    expect(r.errors).toEqual([]);
    expect(r.outputFiles[0]!.contents.length).toBeLessThan(60_000);
  });
  it("the guard catches a Lucid import", async () => {
    await expect(bundle("../../src/core/data.ts")).rejects.toThrow(/light path imports @lucid-evolution/);
  });
});
