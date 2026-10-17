#!/usr/bin/env bash
# app/test/public-e2e.sh: the public page on the devnet, in headless Chrome.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/cli/vault"
export VAULT_NETWORK=Custom
ADMIN=http://localhost:10000/local-cluster/api
STORE=http://localhost:8080/api/v1
T="$(mktemp -d)"; export VAULT_HOME=$T/owners
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do [[ $(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0') -gt 0 ]] && return 0; sleep 1; done
}

# Agent txs start their validity 60 s in the past, which a devnet younger than that can't express.
for _ in $(seq 1 120); do [[ $(curl -s "$STORE/blocks/latest" | jq '.slot // 0') -ge 90 ]] && break; sleep 1; done

echo "== a vault with one agent and one payment"
for k in a b agent payee; do $V keys gen $k >/dev/null; done
topup "$($V keys show a | jq -r .address)" 1000; topup "$($V keys show agent | jq -r .address)" 10
$V vault create --owners a,b --threshold 2 --max-validity 2m --payer a >/dev/null
$V treasury fund --ada 100 --payer a >/dev/null
PAYEE=$($V keys show payee | jq -r .address)
UNIT=$($V allowance grant --agent agent --dest "$PAYEE" --cap lovelace:25:10 --fund 40 --from-treasury --propose a --sign a,b | jq -rs '.[0].allowance')
PAID=$($V agent spend "$UNIT" --to "$PAYEE" --ada 4 --intent-id INV-PUB-1 --purpose "hosting, October" --agent agent) || fail "agent spend: $PAID"
POLICY=$($V vault info | jq -r .policy)
ok "vault $POLICY"

echo "== server and app"
(cd "$ROOT/app" && VITE_NETWORK=Custom npx vite build --outDir "$T/dist" --emptyOutDir >/dev/null)
DB=$T/db.sqlite "$ROOT/server/gendo-server" admin register "$POLICY" --name "E2E payouts" >/dev/null
BLOCKFROST_URL=$STORE BLOCKFROST_PROJECT_ID=devnet DB=$T/db.sqlite STATIC_DIR="$T/dist" PORT=8799 "$ROOT/server/gendo-server" 2>"$T/server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf http://localhost:8799/public/$POLICY >/dev/null && break; sleep 1; done

echo "== the page"
TEXT=$(node "$ROOT/app/test/cdp.mjs" "http://localhost:8799/w/$POLICY")
grep -q "E2E payouts" <<<"$TEXT" && ok "listing name shown" || fail "no name: $TEXT"
grep -q "This agent can pay up to 10 ADA at a time and 25 ADA per day, only to this address" <<<"$TEXT" && ok "limits as a sentence" || fail "no sentence: $TEXT"
grep -q "2 of 2 must sign" <<<"$TEXT" && ok "threshold" || fail "no threshold: $TEXT"
grep -qE '4 ADA to 1 payee \+ [0-9.]+ ADA fee, paid by the agent within its limits' <<<"$TEXT" && ok "payment from the chain: amount, fee, agent spend" || fail "no payment: $TEXT"
grep -q "The agent's note (not verified): hosting, October" <<<"$TEXT" && ok "the agent's note, marked unverified" || fail "no note: $TEXT"
TEXT=$(node "$ROOT/app/test/cdp.mjs" "http://localhost:8799/w/$(printf 'ab%.0s' $(seq 1 28))")
grep -q "No vault found" <<<"$TEXT" && ok "unknown id: no vault found" || fail "unknown id: $TEXT"
BLOCKFROST_URL=http://127.0.0.1:9 BLOCKFROST_PROJECT_ID=devnet DB=$T/db.sqlite STATIC_DIR="$T/dist" PORT=8798 "$ROOT/server/gendo-server" 2>/dev/null &
DEAD=$!; trap 'kill $SRV $DEAD 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:8798/ && break; sleep 1; done
TEXT=$(node "$ROOT/app/test/cdp.mjs" "http://localhost:8798/w/$POLICY")
grep -q "The chain is unavailable right now" <<<"$TEXT" && ok "chain down: the page says so" || fail "chain down: $TEXT"
echo PASS
