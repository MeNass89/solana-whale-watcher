#!/bin/bash
# Cloudflare quick tunnel — self-healing public URL for the whale-watcher webhook.
# No account, no login: each start yields a fresh https://<random>.trycloudflare.com.
# On a new URL: rewrite PUBLIC_WEBHOOK_URL in .env and kickstart the service so
# WalletMonitor.syncWebhook() pushes the new URL to Helius (auto-disable cure included).
# cloudflared dies -> script exits -> launchd KeepAlive restarts -> new URL -> re-sync.

set -uo pipefail

REPO="/Users/nassimlecornet/Projects/solana-whale-watcher"
ENV_FILE="$REPO/.env"
LOGFILE="$REPO/data/quick-tunnel.log"
CF_LOG="$REPO/data/cloudflared.log"
CF_BIN="/opt/homebrew/bin/cloudflared"
SERVICE_LABEL="com.nassim.whale-watcher"
WEBHOOK_PATH="/api/webhooks/helius"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" >> "$LOGFILE"; }

: > "$CF_LOG"
"$CF_BIN" tunnel --url http://127.0.0.1:3000 --no-autoupdate >> "$CF_LOG" 2>&1 &
CF_PID=$!
log "cloudflared started (pid $CF_PID)"

URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1)
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || { log "ERROR: cloudflared died before URL assignment"; exit 1; }
  sleep 1
done
if [ -z "$URL" ]; then
  log "ERROR: no trycloudflare URL after 60s"
  kill "$CF_PID" 2>/dev/null
  exit 1
fi
log "tunnel URL: $URL"

CURRENT=$(grep -E '^PUBLIC_WEBHOOK_URL=' "$ENV_FILE" | cut -d= -f2-)
DESIRED="${URL}${WEBHOOK_PATH}"
if [ "$CURRENT" != "$DESIRED" ]; then
  sed -i '' "s|^PUBLIC_WEBHOOK_URL=.*|PUBLIC_WEBHOOK_URL=${DESIRED}|" "$ENV_FILE"
  log "rewrote PUBLIC_WEBHOOK_URL -> $DESIRED; kickstarting $SERVICE_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL" \
    && log "kickstart ok" \
    || log "WARN: kickstart failed (service will pick up URL on next restart)"
else
  log "URL unchanged; no kickstart needed"
fi

FAILS=0
while true; do
  sleep 300
  kill -0 "$CF_PID" 2>/dev/null || { log "cloudflared exited — recycling"; exit 1; }
  if curl -s -m 15 "${URL}/api/health" | grep -q '"ok":true'; then
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    log "WARN: public health check failed ($FAILS/3)"
    if [ "$FAILS" -ge 3 ]; then
      log "ERROR: 3 consecutive health failures — killing tunnel to force recycle"
      kill "$CF_PID" 2>/dev/null
      exit 1
    fi
  fi
done
