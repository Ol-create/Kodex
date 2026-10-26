import { Router } from "express";

export function tenantRoutes() {
  const router = Router();

  // Returns the tenant the API key belongs to. Handy for checking a key works.
  router.get("/", (req, res) => {
    const { id, slug, name, config } = req.tenant;
    res.json({ id, slug, name, config });
  });

  return router;
}
