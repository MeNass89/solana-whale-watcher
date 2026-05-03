import { logger } from "../utils/logger.js";

export async function runCleanup(): Promise<void> {
  logger.info("Cleanup job is not active in Phase 1");
}
