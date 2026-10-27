import { Router } from "express";
import { AppError } from "../../utils/AppError.js";
import { askSchema, searchSchema } from "./ask.service.js";

// Mounted under /v1, after apiKeyAuth, so req.tenant is always set.
export function askRoutes({ askService }) {
  const router = Router();

  // Retrieval only, no LLM call. For debugging, evaluation and custom UIs.
  router.post("/search", async (req, res) => {
    const input = searchSchema.parse(req.body);
    const { sources, confidence } = await askService.retrieve(req.tenant, input);
    res.json({ confidence, results: sources });
  });

  router.post("/ask", async (req, res) => {
    const input = askSchema.parse(req.body);

    if (!input.stream) {
      return res.json(await askService.ask(req.tenant, input));
    }

    // Server-Sent Events:
    //   sources  { sources, confidence }  once retrieval is done
    //   delta    { text }                 answer text as it is generated
    //   done     <same body as the non-streaming response>
    //   error    { code, message }        if something fails mid-stream
    // `done.answer` is authoritative: on a refusal it replaces the streamed text.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let started = false;
    const send = (event, data) => {
      if (!started) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no", // stop nginx buffering the stream
        });
        started = true;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await askService.ask(req.tenant, input, {
        signal: controller.signal,
        onSources: (sources, confidence) => send("sources", { sources, confidence }),
        onText: (text) => send("delta", { text }),
      });
      send("done", result);
      res.end();
    } catch (err) {
      // Before the stream opens, use the normal JSON error response.
      if (!started) throw err;
      if (controller.signal.aborted) return; // client went away
      console.error(err);
      const safe = err instanceof AppError;
      send("error", { code: safe ? err.code : "internal_error", message: safe ? err.message : "Something went wrong" });
      res.end();
    }
  });

  return router;
}
