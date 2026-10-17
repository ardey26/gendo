#!/usr/bin/env bash
# Bundle gendo-agent into one file. Lucid stays a dependency (it loads its own WASM); everything else,
# the SDK and the MCP runtime included, goes into dist/main.mjs.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
rm -rf dist && mkdir -p dist
"$ROOT/sdk/node_modules/.bin/esbuild" src/main.ts --bundle --platform=node --format=esm --target=node22 \
  --external:@lucid-evolution/lucid --outfile=dist/main.mjs --log-level=warning \
  --banner:js="import { createRequire as __gendoRequire } from 'node:module'; const require = __gendoRequire(import.meta.url);"
chmod +x dist/main.mjs
# Running from a checkout: let dist/ find Lucid the way an installed package would.
mkdir -p node_modules
[ -e node_modules/@lucid-evolution ] || ln -s ../../sdk/node_modules/@lucid-evolution node_modules/@lucid-evolution
