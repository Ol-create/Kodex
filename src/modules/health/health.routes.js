import { Router } from "express";

export function healthRoutes({ db }) {
  const router = Router();

  // Liveness: the process is up.
  router.get("/", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Readiness: the database is reachable and pgvector is installed.
  router.get("/ready", async (req, res) => {
    try {
      const rows = await db.$queryRaw`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
      if (rows.length === 0) {
        return res.status(503).json({ status: "unavailable", database: "ok", pgvector: "missing" });
      }
      res.json({ status: "ok", database: "ok", pgvector: rows[0].extversion });
    } catch (err) {
      console.error("Readiness check failed:", err.message);
      res.status(503).json({ status: "unavailable", database: "unreachable" });
    }
  });

  return router;
}
