// Verifies the release ZIP as a user would: extract it, then start, restart and stop it
// with the packaged launcher on the current operating system.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const windows = process.platform === "win32";
const platform = windows ? "windows" : "linux";
const required = ["orbital-lab.cjs", "orbital-lab.cmd", "orbital-lab.sh", "launcher.mjs"];

let packageDir;
let workDir;
let port;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(() => resolve()));
  return value;
}

async function newestArchive() {
  let names;
  try {
    names = (await readdir(releaseDir)).filter((name) => /^orbital-lab-.*\.zip$/.test(name));
  } catch {
    throw new Error("release/ does not exist. Run npm run package first.");
  }
  assert(names.length > 0, "No release ZIP found. Run npm run package first.");
  const candidates = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(path.join(releaseDir, name))).mtimeMs })),
  );
  candidates.sort((left, right) => right.mtime - left.mtime);
  return path.join(releaseDir, candidates[0].name);
}

async function extract(archive) {
  const entries = unzipSync(new Uint8Array(await readFile(archive)));
  const roots = new Set(Object.keys(entries).map((name) => name.replaceAll("\\", "/").split("/")[0]));
  assert(roots.size === 1, `Expected one top-level folder in ${archive}, found: ${[...roots].join(", ")}`);
  const folder = [...roots][0];
  for (const name of required) {
    assert(entries[`${folder}/${name}`], `${archive} is missing ${name}.`);
  }
  assert(entries[`${folder}/dist/index.html`], `${archive} is missing dist/index.html.`);
  workDir = await mkdtemp(path.join(tmpdir(), "orbital-lab-smoke-"));
  packageDir = path.join(workDir, folder);
  for (const [name, data] of Object.entries(entries)) {
    const segments = name.replaceAll("\\", "/").split("/");
    assert(segments[0] === folder, `Unexpected archive entry: ${name}`);
    const target = path.resolve(workDir, ...segments);
    assert(target === workDir || target.startsWith(workDir + path.sep), `Unsafe archive entry: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const executable = windows ? "cmd.exe" : "bash";
    const argv = windows
      ? ["/c", path.join(packageDir, "orbital-lab.cmd"), ...args]
      : [path.join(packageDir, "orbital-lab.sh"), ...args];
    // Launch from outside the package to prove that the launcher resolves its own directory.
    const child = spawn(executable, argv, {
      cwd: tmpdir(),
      env: { ...process.env, PORT: String(port) },
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function json(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(2000) });
  assert(response.status === 200, `GET ${pathname} returned ${response.status}`);
  return response.json();
}

async function portIsClosed() {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function dumpLogs() {
  for (const stream of ["stdout", "stderr"]) {
    const file = path.join(packageDir, ".runtime", `${stream}-${platform}.log`);
    try {
      console.error(`--- ${file} ---\n${await readFile(file, "utf8")}`);
    } catch {}
  }
}

async function main() {
  const archive = await newestArchive();
  await extract(archive);
  port = await freePort();
  console.log(`Smoke-testing ${path.basename(archive)} on ${process.platform} (port ${port})...`);

  const started = await run(["start"]);
  assert(started.code === 0, `start exited with ${started.code}:\n${started.output}`);
  const first = await json("/api/health");
  assert(Number.isInteger(first.pid), "GET /api/health did not return a pid.");
  const settings = await json("/api/settings");
  assert(settings.demoMode === false, `Unexpected /api/settings: ${JSON.stringify(settings)}`);
  const home = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  assert(home.status === 200, `GET / returned ${home.status}`);
  assert((await home.text()).includes("Orbital Lab"), "GET / did not serve the application shell.");

  const already = await run(["start"]);
  assert(already.code === 0, `Repeated start exited with ${already.code}:\n${already.output}`);
  assert((await json("/api/health")).pid === first.pid, "Repeated start replaced the running instance.");

  const restarted = await run([]);
  assert(restarted.code === 0, `Default restart exited with ${restarted.code}:\n${restarted.output}`);
  const second = await json("/api/health");
  assert(second.pid !== first.pid, "Default restart did not replace the running process.");

  const stopped = await run(["stop"]);
  assert(stopped.code === 0, `stop exited with ${stopped.code}:\n${stopped.output}`);
  assert(await portIsClosed(), "The server still answers after stop.");

  const stoppedAgain = await run(["stop"]);
  assert(stoppedAgain.code === 0, `Repeated stop exited with ${stoppedAgain.code}:\n${stoppedAgain.output}`);
  console.log("OK: the release package starts, restarts and stops with Node.js alone.");
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`Smoke test failed: ${error?.message ?? error}`);
  await dumpLogs().catch(() => {});
  if (packageDir) await run(["stop"]).catch(() => {});
  process.exitCode = 1;
} finally {
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
