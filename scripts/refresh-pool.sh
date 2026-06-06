#!/bin/bash
set -euo pipefail
cd /Users/nassimlecornet/Projects/solana-whale-watcher
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec /opt/homebrew/bin/node --env-file=.env node_modules/.bin/tsx scripts/refresh-pool.ts
