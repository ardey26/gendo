// app/test/bundle-check.mjs
// After `vite build`: the public route must ship no WASM and stay under 200 KB gzipped.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
const dist = new URL("../dist/", import.meta.url);
const files = readdirSync(new URL("assets/", dist));
const wasm = files.filter((f) => f.endsWith(".wasm"));
if (wasm.length) throw new Error(`public build ships WASM: ${wasm.join(", ")}`);
const js = files.filter((f) => f.endsWith(".js"));
const gz = js.reduce((n, f) => n + gzipSync(readFileSync(new URL(`assets/${f}`, dist))).length, 0);
if (gz > 200_000) throw new Error(`public route is ${gz} bytes gzipped (limit 200000)`);
for (const f of js) if (/cardano_multiplatform_lib|lucid-evolution/.test(readFileSync(new URL(`assets/${f}`, dist), "utf8"))) throw new Error(`Lucid found in ${f}`);
console.log(`ok: ${js.length} JS files, ${gz} bytes gzipped, no WASM, no Lucid`);
