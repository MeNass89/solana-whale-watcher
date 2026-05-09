import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";

export function runLeaderboardRefresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    // The leaderboard is currently a CLI script; spawning keeps scheduler wiring small and avoids a broad extraction.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/leaderboard.ts"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        logger.info({ output: stdout.trim() }, "leaderboard-refresh: job completed");
        resolve();
        return;
      }
      reject(new Error(`leaderboard-refresh exited ${code}: ${stderr.trim()}`));
    });
  });
}
