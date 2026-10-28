import { Router } from "express";
import { AppError } from "../../utils/AppError.js";
import { kindSchema, matchSchema, syncSchema } from "./profiles.service.js";

// Mounted under /v1, after apiKeyAuth, so req.tenant is always set.
export function profileRoutes({ profileService }) {
  const router = Router();

  // Create or update profiles of one kind. Unchanged text is not re-embedded.
  // With "replace": true the list is complete and missing profiles are deleted.
  router.put("/profiles/:kind", async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const input = syncSchema.parse(req.body);
    res.json(await profileService.sync(req.tenant, kind, input));
  });

  router.delete("/profiles/:kind/:externalId", async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const count = await profileService.deleteProfile(req.tenant, kind, req.params.externalId);
    if (count === 0) throw new AppError(404, "Profile not found", "profile_not_found");
    res.status(204).end();
  });

  // Ranks profiles by semantic similarity to the query. No LLM call.
  router.post("/match", async (req, res) => {
    const input = matchSchema.parse(req.body);
    res.json({ results: await profileService.match(req.tenant, input) });
  });

  return router;
}
