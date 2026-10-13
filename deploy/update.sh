#!/usr/bin/env bash
# deploy/update.sh: build and restart when master has moved (run as root by gendo-deploy.timer).
# The last good commit is kept in /var/lib/gendo-deploy/deployed, so a failed build is retried next time
# while the running app keeps serving the previous build.
set -euo pipefail
# Wrapped in main so bash reads the whole file before the checkout below rewrites it.
main() {
cd /opt/gendo/repo
as() { runuser -u gendo -- env HOME=/opt/gendo "$@"; }
install -d -m 700 /var/lib/gendo-deploy
as git fetch -q origin master
new=$(as git rev-parse origin/master)
[ "${1:-}" != "--force" ] && [ "$(cat /var/lib/gendo-deploy/deployed 2>/dev/null)" = "$new" ] && exit 0
as git checkout -q --detach "$new"
install -m 644 deploy/gendo.service deploy/gendo-deploy.service deploy/gendo-deploy.timer /etc/systemd/system/
systemctl daemon-reload
for d in sdk server app; do as npm ci --prefix "$d" --no-audit --no-fund --loglevel=error; done
rm -rf app/dist-next
as env VITE_NETWORK=Preprod npm run build --prefix app --silent -- --outDir dist-next --emptyOutDir
rm -rf app/dist && mv app/dist-next app/dist
systemctl restart gendo
echo "$new" > /var/lib/gendo-deploy/deployed
echo "deployed $new"
}
main "$@"
