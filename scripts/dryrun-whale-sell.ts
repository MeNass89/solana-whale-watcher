import DatabaseConstructor from "better-sqlite3";
import { runMigrations, type AppDatabase } from "../src/storage/database.js";
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

// Hard-isolated from the live database: the dry-run used to open
// config.databasePath and run global DELETEs, which in a half-failed scenario
// could wipe real behavioral-exit state. Run everything against an in-memory
// SQLite that is created and discarded inside this script.
const db: AppDatabase = new DatabaseConstructor(":memory:") as AppDatabase;
runMigrations(db);

// Seed wallets so PositionManager.onWhaleSell can classify the senders.
db.prepare(
  `INSERT INTO wallets (address, score, state, active, realized_sol_30d, n_closed_30d, wallet_class)
   VALUES (?, 80, 'ACTIVE', 1, 200, 10, 'alpha')`
).run(ALPHA_A);
db.prepare(
  `INSERT INTO wallets (address, score, state, active, realized_sol_30d, n_closed_30d, wallet_class)
   VALUES (?, 80, 'ACTIVE', 1, 200, 10, 'alpha')`
).run(ALPHA_B);
db.prepare(
  `INSERT INTO wallets (address, score, state, active, realized_sol_30d, n_closed_30d, wallet_class)
   VALUES (?, 5, 'DEMOTED', 0, -50, 4, 'loser')`
).run(LOSER);
db.prepare(
  `INSERT INTO wallets (address, score, state, active, realized_sol_30d, n_closed_30d, wallet_class)
   VALUES (?, 5, 'DEMOTED', 0, 0, 0, 'accumulation_bot')`
).run(BOT);

const wallets = new WalletModel(db);
const calls: ExitCall[] = [];
const manager = new PositionManager();
manager.configure({
  db,
  wallets,
  exitHandler: async (_position, reason, sellPct, panicExit) => {
    calls.push({ reason, sellPct, panicExit: !!panicExit });
    return true;
  }
});

const ins = db.prepare(`
  INSERT INTO positions
    (token_mint, token_symbol, entry_execution_id, convergence_id, amount_token, entry_price_usd,
     current_price_usd, stop_loss_price, take_profit_prices, trailing_stop_pct, peak_price_usd,
     time_stop_at, tier, status, opened_at)
  VALUES (?, 'DRY', NULL, NULL, 1000, 1.0, 1.0, 0.85, '[]', 20, 1.0, NULL, 'NOTABLE', 'OPEN', strftime('%s','now'))
`);
const positionId = Number(ins.run(FAKE_MINT).lastInsertRowid);
console.log(`[setup] inserted fake position id=${positionId} (in-memory DB)`);

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  calls.length = 0;
  await fn();
  console.log(`\n--- ${name} ---`);
  if (calls.length === 0) console.log("  (no exit triggered)");
  for (const call of calls) console.log(`  exit: reason=${call.reason} sellPct=${call.sellPct} panic=${call.panicExit}`);
}

(async () => {
  try {
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
  } finally {
    db.close();
  }
})();
