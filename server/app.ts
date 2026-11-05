import express, { type ErrorRequestHandler } from "express";
import { ConfigurationStore, StoreError } from "./store";

export function createApp(store: ConfigurationStore) {
  const app = express();
  app.disable("x-powered-by");
  // Local JSON writes are same-origin only; no CORS access from other websites.
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      res
        .status(403)
        .json({ error: "Only same-origin requests are accepted." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/configurations", async (_req, res) => {
    res.json({ version: 2, configurations: await store.list() });
  });
  app.put("/api/configurations/:id", async (req, res) => {
    res.json(await store.put(req.params.id, req.body));
  });
  app.delete("/api/configurations/:id", async (req, res) => {
    await store.delete(req.params.id);
    res.status(204).end();
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error instanceof StoreError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 500;
    res
      .status(status)
      .json({
        error:
          error instanceof StoreError
            ? error.message
            : status === 413
              ? "Configuration request is too large."
              : status === 400
                ? "Invalid JSON request."
                : "An unexpected server error occurred.",
      });
  };
  app.use(errorHandler);
  return app;
}
