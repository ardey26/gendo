#!/usr/bin/env bash
# The skill's setup flow (skills/gendo/SKILL.md) with every party in its own
# VAULT_HOME, as in a real deployment: owners A, B and C each hold one key, the
# signer holds the agent key, and the paying agent holds no key at all. Owners
# exchange only key hashes and sign every owner tx offline.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/cli/vault"
export VAULT_NETWORK=Custom
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
STORE=${BLOCKFROST_URL:-http://localhost:8080/api/v1}
T="$(mktemp -d)"; OA=$T/owner_a; OB=$T/owner_b; OC=$T/owner_c; SIG=$T/signer; AG=$T/agent; PY=$T/payee
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
as() { local h=$1; shift; VAULT_HOME=$h "$V" "$@"; }
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do [[ $(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0') -gt 0 ]] && return 0; sleep 1; done
}
received() { curl -s "$STORE/addresses/$1/utxos?count=100" | jq "[.[]? | select(.amount[]? | .unit == \"lovelace\" and .quantity == \"$2\")] | length"; }

echo "== step 1-2: keys, each in its own home"
AGENT=$(as $SIG keys gen agent); AGENT_PKH=$(jq -r .pkh <<<"$AGENT")
PA=$(as $OA keys gen me | jq -r .pkh); PB=$(as $OB keys gen me | jq -r .pkh); PC=$(as $OC keys gen me | jq -r .pkh)
PAYEE=$(as $PY keys gen payee | jq -r .address)
topup "$(jq -r .address <<<"$AGENT")" 10; topup "$(as $OA keys show me | jq -r .address)" 1000; topup "$(as $OB keys show me | jq -r .address)" 50
ok "agent key only in signer home; one owner key per owner home"

echo "== step 3: owner A creates the vault from hashes and funds it"
as $OA vault create --owners $PA,$PB,$PC --threshold 2 --max-validity 2m --payer me >/dev/null
as $OA treasury fund --ada 300 --payer me >/dev/null
for h in $OB $OC $SIG $AG; do mkdir -p $h; cp $OA/state.json $h/; done
ok "vault created; state.json shared"

echo "== step 4: grant built by A, signed by A and B in their own homes"
UNIT=$(as $OA allowance grant --agent $AGENT_PKH --dest "$PAYEE" --cap lovelace:20:10 --period 1d --expires 7d \
  --fund 60 --from-treasury --propose me --signers $PA,$PB --out $T/grant.cbor | jq -rs '.[0].allowance')
as $OB tx describe $T/grant.cbor | jq -e '.vaultRedeemers | index("mint:ManageAllowances")' >/dev/null || fail "describe did not name the vault mint"
as $OA tx witness $T/grant.cbor --key me --out $T/a.wit >/dev/null
as $OB tx witness $T/grant.cbor --key me --out $T/b.wit >/dev/null
as $OA tx assemble $T/grant.cbor $T/a.wit $T/b.wit >/dev/null
ok "allowance $UNIT granted with offline witnesses"

echo "== signer in its own home; agent home has no keys"
SOCK=$SIG/signer.sock
VAULT_HOME=$SIG "$V" signer start --key agent --allowance "$UNIT" --dest "$PAYEE" --socket $SOCK --max-ttl 5m 2>$SIG/signer.log &
SPID=$!; trap 'kill $SPID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do [[ -S $SOCK ]] && break; sleep 1; done
[[ ! -d $AG/keys ]] || fail "agent home has a keys dir"
ok "signer up"

echo "== agent pays through the socket"
as $AG agent spend "$UNIT" --to "$PAYEE" --ada 3 --intent-id INV-1 --signer-socket $SOCK | jq -e .submitted >/dev/null || fail "agent spend"
[[ $(received "$PAYEE" 3000000) == 1 ]] && ok "payee got 3 ADA" || fail "payment missing"

echo "== escalation: agent prepares with owner hashes; signer home + owners witness"
as $AG agent overlimit "$UNIT" --to "$PAYEE" --ada 15 --intent-id INV-2 --cosigners $PA,$PB --out $T/ol.cbor >/dev/null
as $SIG tx witness $T/ol.cbor --key agent --out $T/agent.wit >/dev/null
as $OA tx witness $T/ol.cbor --key me --out $T/a2.wit >/dev/null
as $OB tx describe $T/ol.cbor | jq -e '.intent.id == "INV-2"' >/dev/null || fail "owner B could not read the intent"
as $OB tx witness $T/ol.cbor --key me --out $T/b2.wit >/dev/null
as $OA tx assemble $T/ol.cbor $T/agent.wit $T/a2.wit $T/b2.wit >/dev/null
[[ $(received "$PAYEE" 15000000) == 1 ]] && ok "over-limit 15 ADA co-signed across homes" || fail "co-signed payment missing"

echo "== pause built by B, signed by A and B"
as $OB config set --pause --propose me --signers $PA,$PB --out $T/pause.cbor >/dev/null
as $OA tx witness $T/pause.cbor --key me --out $T/a3.wit >/dev/null
as $OB tx witness $T/pause.cbor --key me --out $T/b3.wit >/dev/null
as $OB tx assemble $T/pause.cbor $T/a3.wit $T/b3.wit >/dev/null
R=$(as $AG agent spend "$UNIT" --to "$PAYEE" --ada 1 --intent-id INV-3 --signer-socket $SOCK || true)
[[ $(jq -r .blocked <<<"$R") == PAUSED ]] && ok "paused vault blocks the agent" || fail "expected PAUSED, got $R"
echo PASS
