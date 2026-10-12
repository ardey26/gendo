#!/usr/bin/env bash
# The skill's "run the signer as its own OS user" setup, checked on Linux with
# real users: the agent user can reach the signer's socket but can't read the
# agent key, and a user outside the group can't connect at all.
# Requires: Docker, and scripts/devnet.sh up (the signer connects to it).
# On the host this re-runs itself inside a Debian container as root.
set -euo pipefail
if [[ "${1:-}" != --inside ]]; then
  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  exec docker run --rm -v "$ROOT":/src:ro node:22-bookworm bash /src/cli/test/signer-user.sh --inside
fi
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
export VAULT_NETWORK=Custom
export BLOCKFROST_URL=http://host.docker.internal:8080/api/v1
export YACI_ADMIN=http://host.docker.internal:10000/local-cluster/api
export YACI_OGMIOS=ws://host.docker.internal:1337

echo "== install (copy of the repo, Linux node_modules)"
mkdir -p /opt/gendo && cd /src && tar --exclude=node_modules --exclude=.git --exclude=.tools --exclude='.vault*' --exclude=build -cf - . | tar -xf - -C /opt/gendo
(cd /opt/gendo/sdk && npm ci --silent >/dev/null 2>&1) || fail "npm ci"
chmod -R a+rX /opt/gendo
V=/opt/gendo/cli/vault

echo "== the skill's setup, as root"
groupadd gendo && useradd -r -g gendo gendo-signer && useradd -m agentuser && usermod -aG gendo agentuser
useradd -m outsider
install -d -o gendo-signer -g gendo -m 750 /var/lib/gendo-signer
ok "users and signer home created"

echo "== agent operator generates the key as the signer user"
runuser -u gendo-signer -- env VAULT_HOME=/var/lib/gendo-signer $V keys gen agent >/dev/null
# Any vault works for this check: the signer only derives the vault from state.json.
echo '{"network":"Custom","seed":{"txHash":"'$(printf '11%.0s' $(seq 1 32))'","outputIndex":0}}' > /var/lib/gendo-signer/state.json
chown gendo-signer:gendo /var/lib/gendo-signer/state.json
ok "key at $(stat -c '%U:%G %a' /var/lib/gendo-signer/keys/agent.sk)"

echo "== start the signer as its own user, socket 660"
SOCK=/var/lib/gendo-signer/signer.sock
runuser -u gendo-signer -- env VAULT_HOME=/var/lib/gendo-signer $V signer start --key agent \
  --allowance 00 --dest addr_test1vqh80pv9r2lkuw8zs0hfeuu85aeadmnfs0rywqs7aghsseytwda \
  --socket $SOCK --socket-mode 660 2>/tmp/signer.log &
for _ in $(seq 1 60); do [[ -S $SOCK ]] && break; sleep 1; done
[[ -S $SOCK ]] || { cat /tmp/signer.log; fail "signer did not start"; }
ok "socket $(stat -c '%U:%G %a' $SOCK)"

echo "== what the agent user can and can't do"
if runuser -u agentuser -- cat /var/lib/gendo-signer/keys/agent.sk >/dev/null 2>&1; then fail "agent user read the key"; fi
ok "agent user can't read the key file"
code=$(runuser -u agentuser -- curl -s -o /dev/null -w '%{http_code}' --unix-socket $SOCK -X POST -d '{"txCbor":"00"}' http://signer/sign || true)
[[ $code == 403 ]] || fail "agent user got HTTP $code from the signer (want 403: reached it, tx refused)"
ok "agent user reaches the signer (a junk tx is refused with 403)"
if runuser -u outsider -- curl -s -o /dev/null --unix-socket $SOCK -X POST -d '{}' http://signer/sign 2>/dev/null; then fail "outsider reached the signer"; fi
ok "a user outside the group can't connect"
echo PASS
