import { refreshLeaderboard } from "../../scripts/leaderboard.js";
import { logger } from "../utils/logger.js";

const LEADERBOARD_TIMEOUT_MS = 10 * 60 * 1000;

export function runLeaderboardRefresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
    }, LEADERBOARD_TIMEOUT_MS);
    timer.unref();
    try {
      refreshLeaderboard({ applyPrune: true });
      clearTimeout(timer);
      logger.info("leaderboard-refresh: job completed");
      resolve();
    } catch (error) {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
