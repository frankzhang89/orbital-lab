import { DEFAULT_APP_SETTINGS, type AppSettings } from "../src/settings";
import { errorDiagnostics } from "../src/messages";
import express, { type ErrorRequestHandler } from "express";
import { ConfigurationStore, StoreError } from "./store";

export function createApp(store: ConfigurationStore, settings: Readonly<AppSettings> = DEFAULT_APP_SETTINGS) {
  const demoMode = settings.demoMode;
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
  app.get("/api/settings", (_req, res) => {
    res.json({ demoMode });
  });
  // Reject before body parsing or any storage access, including malformed writes.
  app.use("/api/configurations", (req, res, next) => {
    if (demoMode && (req.method === "PUT" || req.method === "DELETE")) {
      res.status(403).json({ code: "DEMO_MODE_READ_ONLY", error: errorDiagnostics.DEMO_MODE_READ_ONLY });
      return;
    }
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
