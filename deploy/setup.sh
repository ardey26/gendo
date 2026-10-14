#!/usr/bin/env bash
# deploy/setup.sh: turn a fresh Ubuntu 24.04 server into the gendo app host. Run as root; safe to re-run.
# Needs /etc/gendo/env holding BLOCKFROST_PROJECT_ID=… (preprod). Usage: DOMAIN=app.gendo.cash bash setup.sh
set -euo pipefail
DOMAIN=${DOMAIN:?set DOMAIN}
REPO=${REPO:-https://github.com/gendo-cash/gendo.git}
NODE=24.11.0
test -s /etc/gendo/env || { echo "missing /etc/gendo/env"; exit 1; }
chmod 600 /etc/gendo/env

export DEBIAN_FRONTEND=noninteractive
# A fresh server runs its own first-boot updates: wait for them to let go of apt.
cloud-init status --wait >/dev/null 2>&1 || true
while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; do sleep 5; done
# Small servers (1 GB) need swap for the app's build.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
apt-get update -q
apt-get install -yq git curl xz-utils ufw unattended-upgrades gnupg debian-keyring debian-archive-keyring apt-transport-https

# Security updates install themselves, rebooting at 04:00 when one needs it.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'X'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
X
cat > /etc/apt/apt.conf.d/52gendo <<'X'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
X

# SSH by key only; only SSH and the web are reachable.
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/90-gendo.conf
systemctl reload ssh
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

# Node, pinned and checked against the release's checksums.
if [ "$(node -v 2>/dev/null)" != "v$NODE" ]; then
  t=$(mktemp -d); f=node-v$NODE-linux-x64.tar.xz
  curl -fsSL "https://nodejs.org/dist/v$NODE/$f" -o "$t/$f"
  (cd "$t" && curl -fsSL "https://nodejs.org/dist/v$NODE/SHASUMS256.txt" | grep " $f\$" | sha256sum -c --quiet -)
  tar -xJf "$t/$f" -C /usr/local --strip-components=1
  rm -rf "$t"
fi

# Caddy: HTTPS with certificates it renews itself.
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# The app runs as its own user; its only writable place is the database directory.
id gendo >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/gendo --shell /usr/sbin/nologin gendo
install -d -o gendo -g gendo -m 700 /var/lib/gendo
[ -d /opt/gendo/repo/.git ] || runuser -u gendo -- env HOME=/opt/gendo git clone -q "$REPO" /opt/gendo/repo
cd /opt/gendo/repo
install -m 644 deploy/gendo.service deploy/gendo-deploy.service deploy/gendo-deploy.timer /etc/systemd/system/
sed "s/{DOMAIN}/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload

# First build and start; afterwards the timer redeploys whenever master changes.
/opt/gendo/repo/deploy/update.sh --force
systemctl enable --now gendo gendo-deploy.timer
systemctl reload caddy
echo "gendo is up on https://$DOMAIN"
