#!/bin/bash
# Tailscale Funnel — stable public URL for whale-watcher webhook.
# Replaces ephemeral Cloudflare quick tunnels.
# Runs as launchd service (com.nassim.whale-tunnel).

set -uo pipefail

LOGFILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel.log"
URL_FILE="/Users/nassimlecornet/Projects/solana-whale-watcher/data/tunnel-url.txt"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" >> "$LOGFILE"; }

log "starting tailscale funnel on port 3000"
echo "https://macbook-air-nassim.taila10165.ts.net" > "$URL_FILE"

exec /opt/homebrew/bin/tailscale funnel 3000 >> "$LOGFILE" 2>&1
