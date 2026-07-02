/**
 * Alpha/backtest harness CLI.
 *
 *   npx tsx src/backtest/cli.ts <fetch|resolve|replay|report> [options]
 *
 * The live service keeps running; this CLI never restarts anything and only
 * writes to the live DB through the resolver (see README).
 */
import { DEFAULT_CANDLE_DB } from "./candle-store.js";
import { runFetch } from "./fetcher.js";
import { M1_DEFAULT_SAMPLE, m1TokensToFetch, runM1Report } from "./m1-study.js";
import { runReplay } from "./replay.js";
import { runReport } from "./report.js";
import { runResolve } from "./resolver.js";

const HELP = `solana-whale-watcher alpha/backtest harness

Usage: npx tsx src/backtest/cli.ts <command> [options]

Commands:
  fetch     Pull GeckoTerminal candles for tokens needing resolution into
            data/candles.sqlite (resumable; ~2h for the full universe;
            throttled to 1 req / 2.1s).
  resolve   Historically resolve convergences (outcome BACKFILL, plus PENDING
            older than 8 days) from stored candles. Writes outcome +
            price_1h/24h/7d + resolved_via='candles' to the live DB in
            batches of 200.
              --limit <n>    only resolve the first n rows (smoke runs)
              --dry-run      compute but do not write
  replay    Re-derive convergence events from raw trades with a parameterized
            detector, simulate $-sized entries/exits on candles, walk-forward
            evaluate a config grid. Writes backtest/replay-results.json.
              --latency <s>  entry latency after detection (default 60)
              --size <usd>   fixed position size (default 1000)
  report    Render backtest/REPORT.md (signal study + replay results) and
            copy it to the iCloud temp dir.
  fetch --m1 [--sample <n>]
            Pull candles for the m=1 universe (first whale buy per token),
            deterministic sample of n tokens (default ${M1_DEFAULT_SAMPLE}).
            Run only after the convergence fetch has finished (shared
            GeckoTerminal quota).
  m1-report Render backtest/M1-REPORT.md — horizon curves, walk-forward
            wallet selection, simulated exits for the m=1 signal.
              --sample <n>   must match the fetch sample (default ${M1_DEFAULT_SAMPLE})

Options:
  --candles <path>  candle DB path (default ${DEFAULT_CANDLE_DB})
  --help            this help
`;

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const candleDbPath = argValue(args, "--candles") ?? DEFAULT_CANDLE_DB;

  switch (command) {
    case "fetch": {
      const sample = argValue(args, "--sample");
      const tokensOverride = args.includes("--m1")
        ? m1TokensToFetch(undefined, sample ? Number(sample) : M1_DEFAULT_SAMPLE)
        : undefined;
      await runFetch(candleDbPath, undefined, tokensOverride);
      break;
    }
    case "resolve": {
      const limit = argValue(args, "--limit");
      runResolve({
        candleDbPath,
        limit: limit ? Number(limit) : undefined,
        dryRun: args.includes("--dry-run")
      });
      break;
    }
    case "replay": {
      const latency = argValue(args, "--latency");
      const size = argValue(args, "--size");
      runReplay({
        candleDbPath,
        latencySeconds: latency ? Number(latency) : undefined,
        sizeUsd: size ? Number(size) : undefined
      });
      break;
    }
    case "report":
      runReport();
      break;
    case "m1-report": {
      const sample = argValue(args, "--sample");
      runM1Report({
        candleDbPath,
        sampleSize: sample ? Number(sample) : undefined
      });
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
