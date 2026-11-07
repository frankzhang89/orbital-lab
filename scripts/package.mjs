import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { strToU8, zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const { name, version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const folder = `${name}-${version}`;
const dist = path.join(root, "dist");
await access(path.join(dist, "index.html"));

const server = await build({
  absWorkingDir: root,
  entryPoints: ["server/standalone.ts"],
  outfile: "orbital-lab.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  write: false,
  metafile: true,
  legalComments: "eof",
  plugins: [{
    name: "debug-color-fallback",
    setup(builder) {
      // debug treats supports-color as optional and already has a basic color palette.
      builder.onResolve({ filter: /^supports-color$/ }, ({ importer }) => {
        if (importer.replaceAll("\\", "/").endsWith("/debug/src/node.js")) {
          return { path: "supports-color", namespace: "debug-color-fallback" };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: "debug-color-fallback" }, () => ({
        contents: "module.exports = false;",
      }));
    },
  }],
});
for (const output of Object.values(server.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!isBuiltin(dependency.path)) {
      throw new Error(`The release server has an external dependency: ${dependency.path}`);
    }
  }
}

async function serverNotices() {
  const packages = new Set();
  for (const input of Object.keys(server.metafile.inputs)) {
    const segments = input.replaceAll("\\", "/").split("/");
    const modules = segments.lastIndexOf("node_modules");
    if (modules === -1) continue;
    const packageLength = segments[modules + 1].startsWith("@") ? 2 : 1;
    packages.add(segments.slice(0, modules + 1 + packageLength).join("/"));
  }
  const notices = [];
  for (const directory of [...packages].sort()) {
    const packageRoot = path.resolve(root, directory);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const files = await readdir(packageRoot, { withFileTypes: true });
    const licenses = files.filter((file) => file.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(file.name));
    notices.push(`${manifest.name} ${manifest.version} (${manifest.license ?? "see license"})`);
    for (const file of licenses) {
      notices.push((await readFile(path.join(packageRoot, file.name), "utf8")).trim());
    }
  }
  return strToU8(notices.join("\n\n") + "\n");
}

const files = {
  [`${folder}/orbital-lab.cjs`]: server.outputFiles[0].contents,
  [`${folder}/app-config.json`]: strToU8('{\n  "demoMode": false\n}\n'),
  [`${folder}/LICENSE`]: await readFile(path.join(root, "LICENSE")),
  [`${folder}/THIRD-PARTY-SERVER.txt`]: await serverNotices(),
  [`${folder}/RUN.txt`]: strToU8(
    "Orbital Lab\n\nRequires Node.js 22.12+ in the 22.x series or Node.js 24+.\n" +
    "Run node orbital-lab.cjs and open http://127.0.0.1:5173.\n" +
    "Press Ctrl+C to stop. Set PORT before starting to use a different port.\n" +
    "Edit app-config.json and restart to enable demo mode.\n" +
    "Saved configurations are written to celestial-configs.json beside orbital-lab.cjs.\n" +
    "Keep this directory writable if you plan to save configurations.\n",
  ),
};
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const relative = path.relative(dist, file).split(path.sep).join("/");
  files[`${folder}/dist/${relative}`] = await readFile(file);
}

const outputDir = path.join(root, "release");
const archive = path.join(outputDir, `${folder}.zip`);
const temporary = `${archive}.${randomUUID()}.tmp`;
const zip = zipSync(files, { level: 6 });
await mkdir(outputDir, { recursive: true });
try {
  await writeFile(temporary, zip, { flag: "wx" });
  await rename(temporary, archive);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Created ${archive} (${(zip.length / 1024 / 1024).toFixed(2)} MiB)`);
