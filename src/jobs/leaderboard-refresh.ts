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
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, LEADERBOARD_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
        return;
      }
      if (code === 0) {
        logger.info({ output: stdout.trim() }, "leaderboard-refresh: job completed");
        resolve();
        return;
      }
      reject(new Error(`leaderboard-refresh exited ${code}: ${stderr.trim()}`));
    });
  });
}
