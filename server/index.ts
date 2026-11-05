import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createApp } from "./app";
import { ConfigurationStore } from "./store";

const root = fileURLToPath(new URL("..", import.meta.url));
const production = process.argv.includes("--production");
const app = createApp(
  new ConfigurationStore(path.join(root, "celestial-configs.json")),
);
const server = createServer(app);
if (production) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 5173);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `\n  ORBITAL LAB\n  Local: http://127.0.0.1:${port}\n  Configurations: ${path.join(root, "celestial-configs.json")}\n`,
  ),
);
server.on("error", (error) => {
  console.error(`Server failed: ${error.message}`);
  process.exitCode = 1;
});
