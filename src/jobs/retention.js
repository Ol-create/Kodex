import { logger } from "../lib/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Deletes QueryLog rows older than `days`, now and then once a day. Safe to run
// on several instances at once: the delete is idempotent. Returns a stop function.
export function scheduleRetention({ queryLog, days, log = logger, now = () => Date.now() }) {
  if (!days) {
    log.info("Query log retention is off (QUERY_LOG_RETENTION_DAYS=0)");
    return () => {};
  }

  const run = async () => {
    try {
      const count = await queryLog.deleteOlderThan(new Date(now() - days * DAY_MS));
      if (count) log.info("Deleted old query logs", { count, olderThanDays: days });
    } catch (err) {
      log.error("Query log retention failed", { err: err.message });
    }
  };

  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
