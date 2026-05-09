import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { config } from "../src/config/index.js";
import { PositionManager } from "../src/execution/position-manager.js";
import { WalletModel } from "../src/storage/models/wallets.js";

const FAKE_MINT = "DRYRUNTESTMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ALPHA_A = "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t";
const ALPHA_B = "2h7s3FpSvc6v2oHke6Uqg191B5fPCeFTmMGnh5oPWhX7";
const LOSER = "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz";
const BOT = "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c";

interface ExitCall {
  reason: string;
  sellPct: number;
  panicExit: boolean;
}

const dbPath = path.resolve(process.cwd(), config.databasePath);
const db = new DatabaseConstructor(dbPath);
db.pragma("journal_mode = WAL");

const wallets = new WalletModel(db);
const calls: ExitCall[] = [];
const manager = new PositionManager();
manager.configure({
  db,
  wallets,
  exitHandler: async (_position, reason, sellPct, panicExit) => {
    calls.push({ reason, sellPct, panicExit: !!panicExit });
  }
});

// cleanup any stale dry-run state
db.prepare("DELETE FROM positions WHERE token_mint = ?").run(FAKE_MINT);
db.prepare("DELETE FROM execution_config WHERE key LIKE 'position:%:behavioral_sellers' OR key LIKE 'position:%:pending_behavioral_exit_at'").run();

// insert a fake OPEN position
const ins = db.prepare(`
  INSERT INTO positions
    (token_mint, token_symbol, entry_execution_id, convergence_id, amount_token, entry_price_usd,
     current_price_usd, stop_loss_price, take_profit_prices, trailing_stop_pct, peak_price_usd,
     time_stop_at, tier, status, opened_at)
  VALUES (?, 'DRY', NULL, NULL, 1000, 1.0, 1.0, 0.85, '[]', 20, 1.0, NULL, 'NOTABLE', 'OPEN', strftime('%s','now'))
`);
const positionId = Number(ins.run(FAKE_MINT).lastInsertRowid);
console.log(`[setup] inserted fake position id=${positionId}`);

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  calls.length = 0;
  await fn();
  console.log(`\n--- ${name} ---`);
  if (calls.length === 0) console.log("  (no exit triggered)");
  for (const call of calls) console.log(`  exit: reason=${call.reason} sellPct=${call.sellPct} panic=${call.panicExit}`);
}

(async () => {
  await scenario("S1: sellPct < 20 (15%) — should NO-OP", async () => {
    await manager.onWhaleSell(ALPHA_A, FAKE_MINT, 15);
  });

  await scenario("S2: loser sells 30% — should be IGNORED (untrusted)", async () => {
    await manager.onWhaleSell(LOSER, FAKE_MINT, 30);
  });

  await scenario("S3: bot sells 30% — should be IGNORED (untrusted)", async () => {
    await manager.onWhaleSell(BOT, FAKE_MINT, 30);
  });

  await scenario("S4: alpha A sells 30% — first sell → 50% + timer", async () => {
    await manager.onWhaleSell(ALPHA_A, FAKE_MINT, 30);
  });

  await scenario("S5: alpha B sells 30% — second distinct seller → 100% exit", async () => {
    await manager.onWhaleSell(ALPHA_B, FAKE_MINT, 30);
  });

  // cleanup
  db.prepare("DELETE FROM positions WHERE id = ?").run(positionId);
  db.prepare("DELETE FROM execution_config WHERE key = ?").run(`position:${positionId}:behavioral_sellers`);
  db.prepare("DELETE FROM execution_config WHERE key = ?").run(`position:${positionId}:pending_behavioral_exit_at`);
  console.log(`\n[cleanup] removed fake position ${positionId} and its config keys`);
  db.close();
})();
