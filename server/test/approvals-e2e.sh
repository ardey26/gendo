#!/usr/bin/env bash
# server/test/approvals-e2e.sh: owners approve through the server on the devnet.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/cli/vault"
TSX="$ROOT/sdk/node_modules/.bin/tsx"
OC="$ROOT/server/test/owner-client.ts"
export VAULT_NETWORK=Custom
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
STORE=${BLOCKFROST_URL:-http://localhost:8080/api/v1}
export SERVER=http://localhost:8797
T="$(mktemp -d)"; OWN=$T/owners; SIG=$T/signer; AG=$T/agent
as() { local h=$1; shift; VAULT_HOME=$h "$V" "$@"; }
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do [[ $(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0') -gt 0 ]] && return 0; sleep 1; done
}
received() { curl -s "$STORE/addresses/$1/utxos?count=100" | jq "[.[]? | select(.amount[]? | .unit == \"lovelace\" and .quantity == \"$2\")] | length"; }
paused() { as $OWN vault info | jq -r .config.paused; }
status_of() { TOKEN=$TA "$TSX" "$OC" list "$POLICY" | jq -r ".[] | select(.id==\"$1\") | .status"; }
# Agent txs start their validity 60 s in the past, which a devnet younger than that can't express.
for _ in $(seq 1 120); do [[ $(curl -s "$STORE/blocks/latest" | jq '.slot // 0') -ge 90 ]] && break; sleep 1; done

echo "== a 2-of-2 vault with one agent (owners, signer and agent in separate homes)"
AGENT=$(as $SIG keys gen agent)
for k in a b payee; do as $OWN keys gen $k >/dev/null; done
topup "$(jq -r .address <<<"$AGENT")" 10
for k in a b; do topup "$(as $OWN keys show $k | jq -r .address)" 500; done
PA=$(as $OWN keys show a | jq -r .pkh); PB=$(as $OWN keys show b | jq -r .pkh)
as $OWN vault create --owners a,b --threshold 2 --max-validity 2m --payer a >/dev/null  # devnet horizon is minutes
as $OWN treasury fund --ada 100 --payer a >/dev/null
PAYEE=$(as $OWN keys show payee | jq -r .address)
UNIT=$(as $OWN allowance grant --agent "$(jq -r .pkh <<<"$AGENT")" --dest "$PAYEE" --cap lovelace:25:10 --fund 40 \
  --from-treasury --propose a --sign a,b | jq -rs '.[0].allowance')
POLICY=$(as $OWN vault info | jq -r .policy)
ID=$(as $OWN vault info | jq -r .id)
ok "vault ${POLICY:0:16}…, allowance ${UNIT:56:16}…"

echo "== the server"
BLOCKFROST_URL=$STORE BLOCKFROST_PROJECT_ID=devnet VAULT_NETWORK=Custom DB=$T/db.sqlite STATIC_DIR="$ROOT/app/dist" PORT=8797 \
  "$ROOT/server/gendo-server" 2>"$T/server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "$SERVER/public/$POLICY" && break; sleep 1; done
TA=$(TOKEN= "$TSX" "$OC" auth "$OWN/keys/a.sk"); TB=$(TOKEN= "$TSX" "$OC" auth "$OWN/keys/b.sk")
[[ ${#TA} -eq 64 && ${#TB} -eq 64 ]] && ok "both owners signed in with a wallet signature" || fail "sign-in"

echo "== one owner pauses, through the server"
as $OWN config set --pause --propose a --signers $PA --out $T/pause.cbor >/dev/null
as $OWN tx witness $T/pause.cbor --key a --out $T/pause.a.wit >/dev/null
R=$(TOKEN=$TA "$TSX" "$OC" propose "$POLICY" $T/pause.cbor $T/pause.a.wit "Pause all agents")
[[ $(jq -r .status <<<"$R") == submitted ]] || fail "pause not submitted: $R"
for _ in $(seq 1 30); do [[ $(paused) == true ]] && break; sleep 2; done
[[ $(paused) == true ]] && ok "single-owner pause landed" || fail "vault not paused"

echo "== unpause needs both"
as $OWN config set --unpause --propose a --signers $PA,$PB --out $T/un.cbor >/dev/null
as $OWN tx witness $T/un.cbor --key a --out $T/un.a.wit >/dev/null
as $OWN tx witness $T/un.cbor --key b --out $T/un.b.wit >/dev/null
UID_=$(TOKEN=$TA "$TSX" "$OC" propose "$POLICY" $T/un.cbor $T/un.a.wit "Unpause" | jq -r .id)
[[ $(status_of "$UID_") == open ]] && ok "one signature: still open" || fail "submitted early"
[[ $(TOKEN=$TB "$TSX" "$OC" sign "$UID_" $T/un.b.wit | jq -r .status) == submitted ]] || fail "second signature didn't submit"
for _ in $(seq 1 30); do [[ $(paused) == false ]] && break; sleep 2; done
[[ $(paused) == false ]] && ok "unpaused with both signatures" || fail "still paused"

echo "== the agent asks for more through MCP; owners approve in the inbox"
AT=$(TOKEN=$TA "$TSX" "$OC" token "$POLICY" "$UNIT")
as $SIG vault join "$ID" >/dev/null; as $AG vault join "$ID" >/dev/null
SOCK=$SIG/signer.sock
VAULT_HOME=$SIG "$V" signer start --key agent --allowance "$UNIT" --dest "$PAYEE" --socket $SOCK --allow-cosigned --max-cosigned-ttl 2h \
  2>$SIG/signer.log &
SPID=$!; trap 'kill $SRV $SPID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do [[ -S $SOCK ]] && break; sleep 1; done
OUT=$(GENDO_SERVER=$SERVER GENDO_AGENT_TOKEN=$AT VAULT_HOME=$AG "$TSX" "$ROOT/mcp/test/call.ts" "$UNIT" "$SOCK" request_approval \
  "{\"to\":\"$PAYEE\",\"amount_ada\":15,\"intent_id\":\"INV-E2E\",\"purpose\":\"annual hosting\",\"reason\":\"over the 10 ADA cap\"}" 2>$T/mcp.log) \
  || { tail -20 $T/mcp.log; fail "MCP call"; }
RID=$(jq -r .request_id <<<"$OUT"); [[ -n $RID && $RID != null ]] || fail "no request: $OUT"
[[ $(status_of "$RID") == open ]] && ok "the request reached the inbox, signed by the agent" || fail "request not open"
TOKEN=$TA "$TSX" "$OC" list "$POLICY" | jq -r ".[] | select(.id==\"$RID\") | .cbor" > $T/req.cbor
as $OWN tx witness $T/req.cbor --key a --out $T/req.a.wit >/dev/null
as $OWN tx witness $T/req.cbor --key b --out $T/req.b.wit >/dev/null
TOKEN=$TA "$TSX" "$OC" sign "$RID" $T/req.a.wit >/dev/null
[[ $(TOKEN=$TB "$TSX" "$OC" sign "$RID" $T/req.b.wit | jq -r .status) == submitted ]] || fail "request not submitted"
for _ in $(seq 1 30); do [[ $(received "$PAYEE" 15000000) == 1 ]] && break; sleep 2; done
[[ $(received "$PAYEE" 15000000) == 1 ]] && ok "owners approved in the inbox; the payee got 15 ADA" || fail "payee not paid"
echo PASS
