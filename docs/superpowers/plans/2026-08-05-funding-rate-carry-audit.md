# Funding-Rate Carry Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch public SOL/BTC/ETH perpetual-funding histories from Hyperliquid, Binance, and Bybit; simulate a retail-executable delta-neutral carry strategy; and produce a reproducible evidence-backed report.

**Architecture:** One dependency-free Node ESM module owns API pagination, normalization, 8-hour UTC block aggregation, simulation, validation, and Markdown rendering. A Node test module imports its pure functions and proves the numerical conventions before any network run. Raw API responses and run metadata live under `data/funding-audit/`; the final report lives at the repository root.

**Tech Stack:** Node.js 22, built-in `fetch`, `node:test`, JSON, Markdown.

## Global Constraints

- Never modify or access the running service, `.env`, `src/`, or `data/whale-watcher.sqlite`.
- Audit window is `2025-01-01T00:00:00.000Z` through the earlier of live time and `2026-08-05T23:59:59.999Z`.
- Binance and Bybit annualized percent is `rate * 3 * 365 * 100`; Hyperliquid is `rate * 24 * 365 * 100`.
- Hyperliquid's eight hourly realized payments are summed into each complete 8-hour UTC block; Binance and Bybit contribute their single realized payment for that block. No missing payment is filled with zero.
- Daily decisions occur just after 00:00 UTC funding settlement using the completed 8-hour block; new entries accrue only later blocks.
- Enter when absolute spread is strictly above 5%, 10%, or 15%; exit when it is strictly below 50% of entry or when the sign flips.
- Each leg has unit notional and unit collateral; every reported strategy return divides P&L by total deployed collateral of two units.
- Round-trip cost on deployed capital is `feeA + feeB + 2 * 0.02%`, using venue taker fees Binance 0.05%, Bybit 0.055%, and Hyperliquid 0.045%.
- API calls pause between pages and retry transient failures once.

---

### Task 1: Pure numerical contract

**Files:**
- Create: `data/funding-audit/funding-audit.test.mjs`
- Create: `data/funding-audit/funding-audit.mjs`

**Interfaces:**
- Produces: `annualizedPct(venue, rate)`, `buildVenueBlocks(records, venue, startMs, endMs)`, `buildPairBlocks(recordsA, venueA, recordsB, venueB, startMs, endMs)`, `simulateStrategy(options)`, and `splitWindow(startMs, endMs)`.

- [ ] **Step 1: Write failing tests**

  Test exact multipliers; ensure eight complete Hyperliquid hourly payments form one block while seven form none; ensure positive `A-B` selects short A/long B; ensure entry-time funding is excluded, exit-time funding is included; ensure round-trip costs are divided by two units of collateral; ensure 5% hysteresis exits below 2.5%; ensure independent halves force-close at their own boundary.

- [ ] **Step 2: Run tests and confirm RED**

  Run: `/opt/homebrew/opt/node@22/bin/node --test data/funding-audit/funding-audit.test.mjs`

  Expected: failure because `funding-audit.mjs` does not yet export the contract.

- [ ] **Step 3: Implement the minimal pure functions**

  Use sorted immutable records `{timestamp, rate}`; snap millisecond jitter to the nearest native funding boundary within five minutes; emit only complete common 8-hour blocks; accrue each block with `orientation * (rateA - rateB)`; deduct fees and slippage once per completed or forced-closed round trip.

- [ ] **Step 4: Run tests and confirm GREEN**

  Run: `/opt/homebrew/opt/node@22/bin/node --test data/funding-audit/funding-audit.test.mjs`

  Expected: all tests pass with exit code 0.

### Task 2: Public-data collector

**Files:**
- Modify: `data/funding-audit/funding-audit.mjs`
- Create at runtime: `data/funding-audit/raw/*.json`
- Create at runtime: `data/funding-audit/run-metadata.json`

**Interfaces:**
- Produces: canonical records `{venue, asset, timestamp, rate, raw}` and per-source coverage/error metadata.

- [ ] **Step 1: Add fixture-driven pagination tests**

  Prove Binance advances `startTime` past the last ascending row; Hyperliquid advances past its last capped row; Bybit walks `endTime` backward from the earliest descending row; duplicates are removed by timestamp; out-of-window rows are excluded; only network, 429, and 5xx failures receive one retry.

- [ ] **Step 2: Run the new tests and confirm RED**

  Run the Node test command and observe failures caused by missing collectors.

- [ ] **Step 3: Implement collectors**

  Fetch all three assets from all three endpoints, pause 200 ms after every page, retry once after 750 ms for transient errors, validate HTTP and exchange-level status, and persist the exact successful response rows plus a canonical projection.

- [ ] **Step 4: Run tests and confirm GREEN**

  Run the Node test command and require exit code 0.

- [ ] **Step 5: Fetch the live window**

  Run: `/opt/homebrew/opt/node@22/bin/node data/funding-audit/funding-audit.mjs fetch`

  Expected: nine raw JSON files, or source-specific error records that quote endpoint, status, and response excerpt.

### Task 3: Statistics, simulation, and report

**Files:**
- Modify: `data/funding-audit/funding-audit.mjs`
- Create at runtime: `data/funding-audit/analysis.json`
- Create at runtime: `funding-audit-report.md`

**Interfaces:**
- Consumes: canonical records and run metadata.
- Produces: full-window and monthly spread statistics, 27 strategy configurations with full/first/second-half metrics, and the taxonomy verdict.

- [ ] **Step 1: Add analysis tests**

  Prove quantile interpolation, non-zero sign-flip counting, monthly grouping, annualization over fixed calendar exposure, round-trips per year, average hold days, worst net trade, and verdict precedence (`exploitable`, then `marginal`, then `dead`).

- [ ] **Step 2: Run the new tests and confirm RED**

  Run the Node test command and observe failures caused by missing analysis functions.

- [ ] **Step 3: Implement analysis and Markdown renderer**

  Render data coverage and gaps, methodology and assumptions, full spread table, monthly spread table, full strategy table, time-split table, explicit best configuration, verdict, and live-breakage risks. Select the best configuration by the lower of its two half-period net annualized returns, then full-period return, then lower turnover. State that signals are lagged realized funding, not archived predicted rates.

- [ ] **Step 4: Run the new tests and confirm GREEN**

  Run the Node test command and require exit code 0.

- [ ] **Step 5: Analyze cached raw data and write the report**

  Run: `/opt/homebrew/opt/node@22/bin/node data/funding-audit/funding-audit.mjs analyze`

  Expected: `analysis.json` and `funding-audit-report.md` are written without another API call.

### Task 4: Final audit gate

**Files:**
- Verify: `data/funding-audit/**`
- Verify: `funding-audit-report.md`

- [ ] **Step 1: Run standalone tests**

  Run the Node test command; require zero failures.

- [ ] **Step 2: Run project tests**

  Run: `npm test -- --run`; require zero failures.

- [ ] **Step 3: Validate artifacts mechanically**

  Run the script's `validate` command; require internally consistent row counts, sorted unique timestamps, no lookahead in aligned rows, all requested tables, and a named best configuration when at least one pair is analyzable.

- [ ] **Step 4: Verify protected paths are untouched**

  Run: `git status --short` and inspect the diff. Confirm no change under `src/`, `.env`, or any SQLite file.

- [ ] **Step 5: Record environment limitations**

  If branching, fetching, or any venue endpoint was blocked, state the exact error in the report and final handoff.
