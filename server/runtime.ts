import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type Express } from "express";
import { createApp } from "./app";
import { readAppSettings } from "./settings";
import { ConfigurationStore } from "./store";

type ConfigureDevelopment = (app: Express, server: Server) => Promise<void>;

function reportError(error: unknown) {
  console.error(`Server failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

export async function runServer(root: string, configureDevelopment?: ConfigureDevelopment) {
  try {
    const configurationFile = path.join(root, "celestial-configs.json");
    const settings = await readAppSettings(path.join(root, "app-config.json"));
    const app = createApp(new ConfigurationStore(configurationFile), settings);
    const server = createServer(app);
    if (configureDevelopment) {
      await configureDevelopment(app, server);
    } else {
      const dist = path.join(root, "dist");
      app.use(express.static(dist));
      app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
    }
    const port = Number(process.env.PORT || 5173);
    server.on("error", reportError);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      console.log(`\n  ORBITAL LAB\n  Local: http://127.0.0.1:${listeningPort}\n  Configurations: ${configurationFile}\n`);
    });
  } catch (error) {
    reportError(error);
  }
}
