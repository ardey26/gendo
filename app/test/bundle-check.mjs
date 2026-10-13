// After `vite build`: the public route (entry + PublicPage chunk and their static imports) must ship
// no WASM, no Lucid, and stay under 200 KB gzipped. Owner routes may load Lucid.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(".vite/manifest.json", dist), "utf8"));
const entry = Object.values(manifest).find((c) => c.isEntry);
const pub = manifest["src/public/PublicPage.tsx"];
if (!entry || !pub) throw new Error("manifest lacks the entry or the public page chunk");
const files = new Set();
const walk = (c) => {
  if (!c || files.has(c.file)) return;
  files.add(c.file);
  for (const k of c.imports ?? []) walk(manifest[k]);
};
walk(entry);
walk(pub);
let gz = 0;
for (const f of files) {
  if (f.endsWith(".wasm")) throw new Error(`public route ships WASM: ${f}`);
  const body = readFileSync(new URL(f, dist));
  if (f.endsWith(".js") && /cardano_multiplatform_lib|lucid-evolution/.test(body.toString("utf8"))) throw new Error(`Lucid found in ${f}`);
  gz += gzipSync(body).length;
}
if (gz > 200_000) throw new Error(`public route is ${gz} bytes gzipped (limit 200000)`);
console.log(`ok: public route ${files.size} files, ${gz} bytes gzipped, no WASM, no Lucid`);
