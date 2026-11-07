#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The launcher always resolves the package it lives in, never the caller's working directory.
const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, "orbital-lab.cjs");
const runtimeDir = path.join(root, ".runtime");
const stateFile = path.join(runtimeDir, "server.json");
const lockFile = path.join(runtimeDir, "control.lock");
const platform = process.platform === "win32" ? "windows" : "linux";
const outLog = path.join(runtimeDir, `stdout-${platform}.log`);
const errLog = path.join(runtimeDir, `stderr-${platform}.log`);

const ACTIONS = new Set(["start", "restart", "stop"]);
const DEFAULT_PORT = 5173;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 200;

class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 1;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function usage() {
  console.error("Usage: orbital-lab.cmd start|restart|stop");
  console.error("       bash orbital-lab.sh start|restart|stop");
  console.error("No argument restarts the server, starting it when it is stopped.");
  process.exit(2);
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 12) || major >= 24)) {
    throw new LauncherError("Unsupported Node.js. Use Node.js 22.12+ in the 22.x series or Node.js 24+.");
  }
}

async function requirePackage() {
  try {
    await access(entry);
  } catch {
    throw new LauncherError(`Cannot find ${entry}. Run this launcher from an extracted Orbital Lab release package.`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readRecord() {
  let text;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new LauncherError(`Unable to read ${stateFile}. Check file permissions.`);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new LauncherError(`Cannot validate ${stateFile}. No process was stopped. Inspect the record before removing it.`);
  }
  const valid =
    record !== null &&
    typeof record === "object" &&
    record.version === 1 &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    Number.isInteger(record.port) &&
    record.port >= 1 &&
    record.port <= 65535 &&
    typeof record.node === "string" &&
    path.isAbsolute(record.node) &&
    typeof record.entry === "string" &&
    path.isAbsolute(record.entry) &&
    record.root === root &&
    record.entry === entry;
  if (!valid) {
    throw new LauncherError(`Cannot validate ${stateFile}. No process was stopped. Inspect the record before removing it.`);
  }
  return record;
}

async function writeRecord(record) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(temporary, stateFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    return Number.isInteger(body?.pid) ? body : null;
  } catch {
    return null;
  }
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new LauncherError(`Port ${port} is already in use. No process was stopped.`));
      } else {
        reject(new LauncherError(`Unable to check port ${port}: ${error.message}`));
      }
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close(() => resolve());
    });
  });
}

function resolvePort() {
  const raw = process.env.PORT ?? "";
  if (raw === "") return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(raw)) {
    throw new LauncherError("PORT must be an integer between 1 and 65535.");
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new LauncherError("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

async function acquireLock() {
  await mkdir(runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(String(process.pid));
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new LauncherError(`Unable to lock ${runtimeDir}. Check directory permissions.`);
      }
      const stale = await stat(lockFile).then((value) => value.mtimeMs).catch(() => null);
      if (stale !== null && Date.now() - stale > LOCK_STALE_MS) {
        await rm(lockFile, { force: true });
        continue;
      }
      throw new LauncherError("Another control command is running. Try again after it finishes.");
    }
  }
  throw new LauncherError("Another control command is running. Try again after it finishes.");
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {}
  await rm(lockFile, { force: true });
}

async function terminate(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new LauncherError(`Unable to stop process ${pid}: ${error.message}`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(POLL_INTERVAL_MS);
  }
  if (process.platform !== "win32" && isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    const killDeadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < killDeadline) {
      if (!isAlive(pid)) return;
      await delay(POLL_INTERVAL_MS);
    }
  }
  if (isAlive(pid)) throw new LauncherError("The managed process did not stop. Restart cancelled.");
}

async function stop() {
  const record = await readRecord();
  if (!record) {
    console.log("Orbital Lab is not running under this script.");
    return;
  }
  if (!isAlive(record.pid)) {
    await rm(stateFile, { force: true });
    console.log("Orbital Lab is not running under this script.");
    return;
  }
  const service = await health(record.port);
  if (service && service.pid !== record.pid) {
    throw new LauncherError("Process identity does not match the record. Refusing to stop an unrelated process.");
  }
  if (!service) {
    throw new LauncherError(
      `The managed process (PID ${record.pid}) is not responding on port ${record.port}. Refusing to stop an unverified process. Inspect it manually, then remove ${stateFile}.`,
    );
  }
  // Verify again immediately before signalling, in case the process changed while checking.
  const confirmed = await health(record.port);
  if (!confirmed || confirmed.pid !== record.pid) {
    throw new LauncherError("Process identity changed. Stop cancelled.");
  }
  await terminate(record.pid);
  await rm(stateFile, { force: true });
  console.log("Orbital Lab stopped.");
}

async function start() {
  const existing = await readRecord();
  if (existing) {
    if (!isAlive(existing.pid)) {
      await rm(stateFile, { force: true });
    } else {
      const service = await health(existing.port);
      if (service && service.pid === existing.pid) {
        console.log(`Orbital Lab is already running at http://127.0.0.1:${existing.port} (PID ${existing.pid}).`);
        return;
      }
      throw new LauncherError("The managed process exists but is not healthy. Use stop or restart; no second instance was started.");
    }
  }
  const port = resolvePort();
  await assertPortFree(port);
  await mkdir(runtimeDir, { recursive: true });

  const out = openSync(outLog, "a");
  const err = openSync(errLog, "a");
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, PORT: String(port) },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new LauncherError(`Unable to start the server: ${error.message}`)));
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  child.unref();

  const record = {
    version: 1,
    pid: child.pid,
    port,
    node: process.execPath,
    entry,
    root,
    startedAt: new Date().toISOString(),
  };
  await writeRecord(record);

  const deadline = Date.now() + START_TIMEOUT_MS;
  let service = null;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) break;
    service = await health(port);
    if (service && service.pid === child.pid) break;
    await delay(POLL_INTERVAL_MS);
  }
  if (!service || service.pid !== child.pid) {
    await terminate(child.pid).catch(() => {});
    await rm(stateFile, { force: true });
    const reason = isAlive(child.pid) ? "The server was not ready within 30 seconds." : "The server exited during startup.";
    throw new LauncherError(`${reason} See ${errLog} and ${outLog}.`);
  }
  console.log(`Orbital Lab started at http://127.0.0.1:${port} (PID ${child.pid}).`);
  console.log(`Logs: ${outLog} and ${errLog}`);
}

async function main() {
  if (process.argv.length > 3) usage();
  const action = process.argv[2] ?? "restart";
  if (!ACTIONS.has(action)) usage();
  checkNode();
  await requirePackage();
  const lock = await acquireLock();
  try {
    if (action === "stop") {
      await stop();
    } else if (action === "restart") {
      await stop();
      await start();
    } else {
      await start();
    }
  } finally {
    await releaseLock(lock);
  }
}

process.on("exit", () => {
  try {
    rmSync(lockFile, { force: true });
  } catch {}
});

main().catch((error) => {
  const message = error instanceof LauncherError ? error.message : `Launcher failed: ${error?.message ?? error}`;
  console.error(message);
  process.exit(error?.exitCode ?? 1);
});
