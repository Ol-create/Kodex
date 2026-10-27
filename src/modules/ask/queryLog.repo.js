export function createQueryLogRepo(db) {
  return {
    // Logging must never fail or slow down an answer, so errors are swallowed.
    record(entry) {
      db.queryLog.create({ data: entry }).catch((err) => console.error("Failed to write query log:", err.message));
    },
  };
}
