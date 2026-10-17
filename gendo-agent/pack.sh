#!/usr/bin/env bash
# Build gendo-agent's install files into <outdir>:
#   gendo-agent-<version>.tgz  for npx and the Cursor / LM Studio links (npm installs its one dependency)
#   gendo.mcpb                 for Claude Desktop (double-click; it runs on Claude's own Node)
set -euo pipefail
OUT="$(mkdir -p "${1:?usage: pack.sh <outdir>}" && cd "$1" && pwd)"
cd "$(dirname "$0")"
VERSION=$(node -p 'require("./package.json").version')
# Claude Desktop builds read either the older format (dxt_version) or the newer one: check with both.
npx -y @anthropic-ai/dxt@0.2.6 validate manifest.json >/dev/null
npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json >/dev/null
./build.sh

# The npm package: dist/, package.json and npm-shrinkwrap.json (which npm honours when installing it).
T=$(mktemp -d)
npm pack --silent --pack-destination "$T" >/dev/null
mv "$T"/*.tgz "$OUT/gendo-agent-$VERSION.tgz"

# The Claude Desktop bundle: manifest, the bundled server, and its dependency installed beside it.
S="$T/mcpb"
mkdir -p "$S/server"
cp manifest.json "$S/"
cp dist/main.mjs "$S/server/main.mjs"
# Exactly the committed dependency tree (npm-shrinkwrap.json, resolved from releases at least two weeks old).
cp package.json "$S/server/package.json"
cp npm-shrinkwrap.json "$S/server/npm-shrinkwrap.json"
(cd "$S/server" && npm ci --silent --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
npx -y @anthropic-ai/mcpb@2.1.2 pack "$S" "$OUT/gendo.mcpb" >/dev/null
rm -rf "$T"
ls -la "$OUT"
