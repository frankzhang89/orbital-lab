import { errorDiagnostics } from "../src/messages";
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
        .json({ code: "SAME_ORIGIN_REQUIRED", error: errorDiagnostics.SAME_ORIGIN_REQUIRED });
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
    res.status(404).json({ code: "API_NOT_FOUND", error: errorDiagnostics.API_NOT_FOUND });
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
    const code = error instanceof StoreError ? error.code : status === 413 ? "REQUEST_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "UNEXPECTED_ERROR";
    res.status(status).json({ code, error: error instanceof StoreError ? error.message : errorDiagnostics[code], params: error instanceof StoreError ? error.params : undefined });
  };
  app.use(errorHandler);
  return app;
}
