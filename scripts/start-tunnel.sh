#!/bin/bash
# Start cloudflared quick tunnel and auto-update Helius webhook with new URL.
# Runs as launchd service. Healthcheck restarts the whole process if tunnel dies.

set -uo pipefail

LOGFILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel.log"
URL_FILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel-url.txt"
ENV_FILE="/Users/nassimlecornet/Projects/solana-whale-watcher/.env"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" >> "$LOGFILE"; }

update_env_url() {
  local webhook_url="$1"
  if grep -q "^PUBLIC_WEBHOOK_URL=" "$ENV_FILE"; then
    sed -i '' "s|^PUBLIC_WEBHOOK_URL=.*|PUBLIC_WEBHOOK_URL=${webhook_url}/api/webhooks/helius|" "$ENV_FILE"
  fi
  log ".env updated → ${webhook_url}"
}

restart_whale_watcher() {
  local delay=5
  for attempt in 1 2 3 4 5; do
    launchctl kickstart -k "gui/$(id -u)/com.nassim.whale-watcher" 2>> "$LOGFILE" || true
    sleep 8
    if curl -sf "http://127.0.0.1:3000/api/health" > /dev/null 2>&1; then
      log "whale-watcher healthy (attempt ${attempt})"
      return 0
    fi
    log "whale-watcher not ready (attempt ${attempt}/5), retry in ${delay}s"
    sleep $delay
    delay=$((delay * 2))
  done
  log "ERROR — whale-watcher failed after 5 attempts"
}

# Healthcheck: runs in background, exits (killing the script) if tunnel is unreachable
healthcheck() {
  sleep 45  # grace period
  while true; do
    sleep 120
    local url
    url=$(cat "$URL_FILE" 2>/dev/null || echo "")
    if [[ -n "$url" ]]; then
      local fails=0
      for _ in 1 2 3; do
        if ! curl -sf --max-time 10 "${url}/api/health" > /dev/null 2>&1; then
          fails=$((fails + 1))
        fi
        sleep 5
      done
      if [[ $fails -ge 3 ]]; then
        log "HEALTHCHECK: 3/3 checks failed for ${url} — exiting to trigger launchd restart"
        kill $$ 2>/dev/null
        exit 1
      fi
    fi
  done
}

healthcheck &

log "starting cloudflared quick tunnel"
LAST_URL=""

/opt/homebrew/bin/cloudflared tunnel --url http://localhost:3000 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOGFILE"

  url=$(echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' || true)
  if [[ -n "$url" && "$url" != "$LAST_URL" ]]; then
    LAST_URL="$url"
    echo "$url" > "$URL_FILE"
    log "Tunnel URL: $url"
    update_env_url "$url"
    restart_whale_watcher &
  fi
done

log "cloudflared pipe ended — script will exit, launchd will restart"
