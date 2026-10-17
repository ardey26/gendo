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
for d in sdk server app mcp; do as npm ci --prefix "$d" --no-audit --no-fund --loglevel=error; done
# gendo-agent's install files (Claude Desktop bundle, npm tarball), served from /dl with the app.
# A failed pack (say, the npm registry is down) keeps the previous files and never blocks a deploy.
as gendo-agent/pack.sh app/public/dl >/dev/null || echo "gendo-agent pack failed; keeping the previous install files" >&2
rm -rf app/dist-next
as env VITE_NETWORK=Preprod npm run build --prefix app --silent -- --outDir dist-next --emptyOutDir
# Keep earlier builds' files for a week: a tab opened before this deploy still loads the
# pages it hasn't visited yet. File names carry a content hash, so nothing collides.
if [ -d app/dist/assets ]; then
  cp -pn app/dist/assets/* app/dist-next/assets/ 2>/dev/null || true
  find app/dist-next/assets -type f -mtime +7 -delete
fi
rm -rf app/dist && mv app/dist-next app/dist
systemctl restart gendo
echo "$new" > /var/lib/gendo-deploy/deployed
echo "deployed $new"
}
main "$@"
