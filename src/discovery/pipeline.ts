/**
 * Wallet-discovery pipeline — inverse of following a fixed wallet list.
 *
 * The m=1 study proved the tracked universe is the defect (2/76 wallets
 * net-positive in realized SOL). So instead of picking wallets and hoping,
 * we mine PROVEN winners: tokens in our own candle DB that did >=multX,
 * pull their on-chain history, find wallets that bought EARLY, keep the
 * recurrent ones, then audit each candidate's whole recent history for
 * realized SOL flow. Output: wallets whose early entries repeat across
 * independent winners AND whose global flow is net-positive.
 *
 * Every stage is resumable (status columns in discovery.sqlite).
 */
import type Database from "better-sqlite3";
import { CandleStore, DEFAULT_CANDLE_DB } from "../backtest/candle-store.js";
import { openLiveReadonly } from "../backtest/live-db.js";
import { fetchParsedBatched, signaturesBackTo, toSwapView } from "./chain.js";
import { openDiscoveryDb, type AuditRow, type WinnerRow } from "./db.js";

const DAY = 86400;
/** Early window: buys within [first_ts, first_ts + 30min] of our candle
 * coverage (which starts ~1h before our whales' entries — pre-pump). */
const EARLY_WINDOW_SECONDS = 1800;
/** Skip tokens whose history exceeds this many signature pages (mega-tokens:
 * paging to their birth would eat the run time for marginal candidates).
 * Signature pages are cheap in CU — the cap is a time budget (~10s/token at
 * 80 pages), not a quota one. */
const MAX_SIG_PAGES = 80;
/** Cap parsed-tx fetches per winner token. */
const MAX_EARLY_TXS = 300;
/** Audit: how much of a candidate's history to read. */
const AUDIT_MAX_TXS = 400;
const AUDIT_WINDOW_DAYS = 60;

export function seedWinners(db: Database.Database, minMult: number, minVolumeUsd: number, candleDbPath = DEFAULT_CANDLE_DB): number {
  const store = new CandleStore(candleDbPath);
  const rows = store.db
    .prepare(
      `SELECT token_mint, ts, close, high, volume FROM candles WHERE timeframe='minute' ORDER BY token_mint, ts`
    )
    .all() as Array<{ token_mint: string; ts: number; close: number; high: number; volume: number }>;
  store.close();

  interface Acc {
    first_ts: number;
    first_close: number;
    peak_ts: number;
    peak_high: number;
    volume: number;
  }
  const byToken = new Map<string, Acc>();
  for (const r of rows) {
    const acc = byToken.get(r.token_mint);
    if (!acc) {
      byToken.set(r.token_mint, {
        first_ts: r.ts,
        first_close: r.close,
        peak_ts: r.ts,
        peak_high: r.high,
        volume: r.volume
      });
    } else {
      if (r.high > acc.peak_high) {
        acc.peak_high = r.high;
        acc.peak_ts = r.ts;
      }
      acc.volume += r.volume;
    }
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO winners (token_mint, first_ts, first_close, peak_ts, mult, volume_usd)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let seeded = 0;
  for (const [mint, acc] of byToken) {
    if (acc.first_close <= 0) continue;
    const mult = acc.peak_high / acc.first_close;
    if (mult < minMult) continue;
    // Beyond 500x inside a ~3h candle window the "baseline" is a near-zero
    // dust close, not a price — the multiple is an artifact, not a pump.
    if (mult > 500) continue;
    if (acc.volume < minVolumeUsd) continue;
    // Peak must come after the early window, otherwise "early buyers" would
    // already be buying the top and the token teaches nothing.
    if (acc.peak_ts < acc.first_ts + EARLY_WINDOW_SECONDS) continue;
    const info = insert.run(mint, acc.first_ts, acc.first_close, acc.peak_ts, mult, acc.volume);
    seeded += info.changes;
  }
  return seeded;
}

export async function harvestEarlyBuyers(db: Database.Database, maxWinners: number): Promise<void> {
  const pending = db
    .prepare(`SELECT * FROM winners WHERE status='pending' ORDER BY mult DESC LIMIT ?`)
    .all(maxWinners) as WinnerRow[];
  console.log(`[discovery] ${pending.length} winners pending early-buyer harvest`);

  // Anchor signatures: our own whales' earliest tx per token. Paginating
  // `before` this anchor jumps straight to the token's early life instead of
  // walking its whole post-pump history backwards from today.
  const live = openLiveReadonly();
  const anchorStmt = live.prepare(
    `SELECT tx_signature FROM trades WHERE token_mint = ? ORDER BY block_time ASC LIMIT 1`
  );

  const setStatus = db.prepare(`UPDATE winners SET status=?, note=? WHERE token_mint=?`);
  const insertBuy = db.prepare(
    `INSERT INTO early_buys (token_mint, wallet, first_buy_ts, sol_spent) VALUES (?, ?, ?, ?)
     ON CONFLICT(token_mint, wallet) DO UPDATE SET
       first_buy_ts = MIN(first_buy_ts, excluded.first_buy_ts),
       sol_spent = sol_spent + excluded.sol_spent`
  );

  let index = 0;
  for (const winner of pending) {
    index++;
    const windowEnd = winner.first_ts + EARLY_WINDOW_SECONDS;
    try {
      const anchor = anchorStmt.get(winner.token_mint) as { tx_signature: string } | undefined;
      let result = anchor
        ? await signaturesBackTo(winner.token_mint, winner.first_ts, MAX_SIG_PAGES, anchor.tx_signature).catch(
            () => ({ sigs: [], complete: false })
          )
        : { sigs: [], complete: false };
      if (result.sigs.length === 0) {
        // anchor tx not in the mint's index (or no anchor) — full backward walk
        result = await signaturesBackTo(winner.token_mint, winner.first_ts, MAX_SIG_PAGES);
      }
      const { sigs, complete } = result;
      if (!complete) {
        setStatus.run("skipped", `history>${MAX_SIG_PAGES}k sigs`, winner.token_mint);
        console.log(`[discovery] ${index}/${pending.length} ${winner.token_mint.slice(0, 6)}… skipped (too big)`);
        continue;
      }
      const early = sigs
        .filter((s) => s.blockTime != null && s.blockTime >= winner.first_ts && s.blockTime <= windowEnd && !s.err)
        .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))
        .slice(0, MAX_EARLY_TXS);

      const parsed = await fetchParsedBatched(early.map((s) => s.signature));
      let buys = 0;
      for (const tx of parsed) {
        const view = toSwapView(tx);
        if (!view) continue;
        const tokenDelta = view.tokenDeltas.get(winner.token_mint) ?? 0;
        if (tokenDelta <= 0) continue; // not a buy of this token
        if (view.solDelta > -0.001) continue; // no meaningful SOL spent (airdrop/transfer)
        insertBuy.run(winner.token_mint, view.feePayer, view.blockTime, -view.solDelta);
        buys++;
      }
      setStatus.run("done", `${early.length} early txs, ${buys} buys`, winner.token_mint);
      console.log(
        `[discovery] ${index}/${pending.length} ${winner.token_mint.slice(0, 6)}… x${winner.mult.toFixed(0)}: ${buys} early buyers`
      );
    } catch (error) {
      setStatus.run("pending", `error: ${error instanceof Error ? error.message.slice(0, 120) : error}`, winner.token_mint);
      console.error(`[discovery] ${winner.token_mint.slice(0, 6)}… failed, left pending:`, error instanceof Error ? error.message : error);
    }
  }
  live.close();
}

export interface CandidateRow {
  wallet: string;
  winners_hit: number;
}

export function candidates(db: Database.Database, minWinners: number): CandidateRow[] {
  return db
    .prepare(
      `SELECT wallet, COUNT(DISTINCT token_mint) AS winners_hit
       FROM early_buys GROUP BY wallet HAVING winners_hit >= ?
       ORDER BY winners_hit DESC`
    )
    .all(minWinners) as CandidateRow[];
}

export async function auditCandidates(db: Database.Database, minWinners: number, maxAudits: number): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const todo = candidates(db, minWinners).filter(
    (c) => !db.prepare(`SELECT 1 FROM audits WHERE wallet=?`).get(c.wallet)
  );
  const capped = todo.slice(0, maxAudits);
  console.log(`[discovery] ${todo.length} candidates to audit (running ${capped.length})`);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO audits (wallet, winners_hit, n_swaps, buy_sol, sell_sol, net_sol, span_days, verdict, audited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let index = 0;
  for (const cand of capped) {
    index++;
    try {
      const { sigs } = await signaturesBackTo(cand.wallet, nowTs - AUDIT_WINDOW_DAYS * DAY, Math.ceil(AUDIT_MAX_TXS / 1000) + 1);
      const recent = sigs
        .filter((s) => s.blockTime != null && s.blockTime >= nowTs - AUDIT_WINDOW_DAYS * DAY && !s.err)
        .slice(0, AUDIT_MAX_TXS);
      if (recent.length === 0) {
        insert.run(cand.wallet, cand.winners_hit, 0, 0, 0, 0, 0, "inactive", nowTs);
        continue;
      }
      const spanDays = ((recent[0].blockTime ?? 0) - (recent[recent.length - 1].blockTime ?? 0)) / DAY;
      const parsed = await fetchParsedBatched(recent.map((s) => s.signature));
      let buySol = 0;
      let sellSol = 0;
      let nSwaps = 0;
      for (const tx of parsed) {
        const view = toSwapView(tx);
        if (!view || view.feePayer !== cand.wallet) continue;
        if (view.tokenDeltas.size === 0) continue;
        const boughtTokens = [...view.tokenDeltas.values()].some((d) => d > 0);
        const soldTokens = [...view.tokenDeltas.values()].some((d) => d < 0);
        if (view.solDelta < -0.001 && boughtTokens) {
          buySol += -view.solDelta;
          nSwaps++;
        } else if (view.solDelta > 0.001 && soldTokens) {
          sellSol += view.solDelta;
          nSwaps++;
        }
      }
      const netSol = sellSol - buySol;
      // The audit reads a bounded slice of history: if the slice is truncated
      // (hyperactive wallet), the flow numbers describe cadence, not P&L.
      const truncated = recent.length >= AUDIT_MAX_TXS && spanDays < AUDIT_WINDOW_DAYS * 0.9;
      const verdict =
        nSwaps < 10 ? "low_n" : truncated ? "hyperactive" : netSol > 0 ? "positive" : "negative";
      insert.run(cand.wallet, cand.winners_hit, nSwaps, buySol, sellSol, netSol, spanDays, verdict, nowTs);
      console.log(
        `[discovery] audit ${index}/${capped.length} ${cand.wallet.slice(0, 6)}… hits=${cand.winners_hit} swaps=${nSwaps} net=${netSol.toFixed(1)} SOL → ${verdict}`
      );
    } catch (error) {
      console.error(`[discovery] audit ${cand.wallet.slice(0, 6)}… failed:`, error instanceof Error ? error.message : error);
    }
  }
}

export function auditResults(db: Database.Database): AuditRow[] {
  return db.prepare(`SELECT * FROM audits ORDER BY net_sol DESC`).all() as AuditRow[];
}

export { openDiscoveryDb };
