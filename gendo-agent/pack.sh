#!/usr/bin/env bash
# Build gendo-agent's install files into <outdir>:
#   gendo-agent-<version>.tgz  for npx and the Cursor / LM Studio links (npm installs its one dependency)
#   gendo.mcpb                 for Claude Desktop (double-click; it runs on Claude's own Node)
set -euo pipefail
OUT="$(mkdir -p "${1:?usage: pack.sh <outdir>}" && cd "$1" && pwd)"
cd "$(dirname "$0")"
VERSION=$(node -p 'require("./package.json").version')
LUCID=$(node -p 'require("./package.json").dependencies["@lucid-evolution/lucid"]')
./build.sh

# The npm package: dist/ plus package.json.
T=$(mktemp -d)
npm pack --silent --pack-destination "$T" >/dev/null
mv "$T"/*.tgz "$OUT/gendo-agent-$VERSION.tgz"

# The Claude Desktop bundle: manifest, the bundled server, and its dependency installed beside it.
S="$T/mcpb"
mkdir -p "$S/server"
cp manifest.json "$S/"
cp dist/main.mjs "$S/server/main.mjs"
printf '{ "private": true, "type": "module", "dependencies": { "@lucid-evolution/lucid": "%s" } }\n' "$LUCID" > "$S/server/package.json"
npm install --silent --omit=dev --no-audit --no-fund --prefix "$S/server" >/dev/null
npx -y @anthropic-ai/mcpb@2.1.2 pack "$S" "$OUT/gendo.mcpb" >/dev/null
rm -rf "$T"
ls -la "$OUT"
