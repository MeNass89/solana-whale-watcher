#!/bin/bash
# Tailscale Funnel — stable public URL for whale-watcher webhook.
# Idempotent: re-uses persistent tailscaled config if funnel already configured for port 3000.
# Runs as launchd service (com.nassim.whale-tunnel).

set -uo pipefail

LOGFILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel.log"
URL_FILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel-url.txt"
TS_BIN="/opt/homebrew/bin/tailscale"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" >> "$LOGFILE"; }

echo "https://macbook-air-nassim.taila10165.ts.net" > "$URL_FILE"

if "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
  log "funnel already configured for port 3000 — entering monitor mode"
else
  log "configuring tailscale funnel on port 3000"
  if ! "$TS_BIN" funnel --bg 3000 >> "$LOGFILE" 2>&1; then
    : > "$URL_FILE"
    log "ERROR: failed to start funnel"
    exit 1
  fi
fi

while true; do
  sleep 300
  if ! "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
    : > "$URL_FILE"
    log "WARN: funnel dropped — exiting to trigger launchd restart"
    exit 1
  fi
done
