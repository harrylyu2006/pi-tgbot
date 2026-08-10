#!/usr/bin/env bash
# Weekly update check for @earendil-works/pi-coding-agent.
# Usage: PI_TG_CONFIG=/etc/pi-tg/config.json ./check-pi-update.sh
set -euo pipefail

CONFIG="${PI_TG_CONFIG:-/etc/pi-tg/config.json}"
ROOT="${PI_TG_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
PKG="@earendil-works/pi-coding-agent"

read_config() {
  node -e 'const c=require(process.argv[1]); process.stdout.write(String(c[process.argv[2]] ?? ""))' "$CONFIG" "$1"
}

BOT_TOKEN="$(read_config botToken)"
CHAT_ID="$(read_config allowedUserId)"
INSTALLED="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.version)' "$ROOT/node_modules/$PKG/package.json")"
LATEST="$(curl -fsS --max-time 15 "https://registry.npmjs.org/${PKG//\//%2F}/latest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version ?? ""))')"

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" || -z "$INSTALLED" || -z "$LATEST" ]]; then
  echo "update check failed"
  exit 1
fi

if [[ "$INSTALLED" == "$LATEST" ]]; then
  echo "up to date: $INSTALLED"
  exit 0
fi

MESSAGE=$(printf 'pi has a new version\nInstalled: %s\nLatest: %s\n\nReview the changelog and back up your installation before upgrading.' "$INSTALLED" "$LATEST")
curl -fsS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" >/dev/null

echo "notified: $INSTALLED -> $LATEST"
