// The browser app imports src/core. This keeps it free of Node-only code:
// esbuild refuses Node built-ins when bundling for the browser.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundle = (entry: string) =>
  build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    external: ["@lucid-evolution/*", "@noble/*"],
    logLevel: "silent",
  });

describe("browser-safe core", () => {
  it("bundles for the browser with no Node built-ins and no Buffer", async () => {
    const r = await bundle("../../src/core/index.ts");
    expect(r.errors).toEqual([]);
    expect(r.outputFiles[0]!.text).not.toMatch(/\bBuffer\b/);
  });
  it("the check catches Node-only code", async () => {
    await expect(bundle("../../src/node/journal.ts")).rejects.toThrow(/node:fs/);
  });
});
