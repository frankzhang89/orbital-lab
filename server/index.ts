import { fileURLToPath } from "node:url";
import { runServer } from "./runtime";

const root = fileURLToPath(new URL("..", import.meta.url));
const production = process.argv.includes("--production");

await runServer(root, production ? undefined : async (app, server) => {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
});
