import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";

const LEADERBOARD_TIMEOUT_MS = 10 * 60 * 1000;

export function runLeaderboardRefresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    // The leaderboard is currently a CLI script; spawning keeps scheduler wiring small and avoids a broad extraction.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/leaderboard.ts"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // A wedged leaderboard run would otherwise hold the scheduler slot
    // forever; SIGTERM first, then SIGKILL after a short grace period.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
    }, LEADERBOARD_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        logger.info({ output: stdout.trim() }, "leaderboard-refresh: job completed");
        resolve();
        return;
      }
      reject(new Error(`leaderboard-refresh exited ${code}: ${stderr.trim()}`));
    });
  });
}
