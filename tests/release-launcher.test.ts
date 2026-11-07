import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { access, cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";

const windows = process.platform === "win32";
const project = process.cwd();
let fixture: string;
let port: number;
const recordFile = () => path.join(fixture, ".runtime", "server.json");
const call = (args: string[], override: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number; text: string }>((resolve) => {
    const executable = windows ? "cmd.exe" : "bash";
    const argv = windows
      ? ["/c", path.join(fixture, "orbital-lab.cmd"), ...args]
      : [path.join(fixture, "orbital-lab.sh"), ...args];
    execFile(
      executable,
      argv,
      { cwd: tmpdir(), env: { ...process.env, PORT: String(port), ...override }, timeout: 45000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, text: stdout + stderr });
      },
    );
  });
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const value = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return value;
}
async function health(at = port) {
  const response = await fetch(`http://127.0.0.1:${at}/api/health`);
  return (await response.json()) as { status: string; pid: number };
}

// The fixture replaces the bundled server with a tiny stand-in that reports its own pid,
// so these tests exercise the launcher without running a production build.
const stub = `const http = require("node:http");
const port = Number(process.env.PORT);
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/health") { response.end(JSON.stringify({ status: "ok", pid: process.pid })); return; }
  if (request.url === "/api/settings") { response.end(JSON.stringify({ demoMode: false })); return; }
  response.statusCode = 404;
  response.end(JSON.stringify({ code: "API_NOT_FOUND" }));
}).listen(port, "127.0.0.1");
`;

describe("release launcher", () => {
  beforeAll(async () => {
    // Resolve 8.3 short names: Windows CI runners report a short %TEMP%, which would
    // disagree with the canonical path the launcher records for itself.
    fixture = await realpath(await mkdtemp(path.join(tmpdir(), "orbital launcher 空格-")));
    for (const file of ["launcher.mjs", "orbital-lab.cmd", "orbital-lab.sh"]) {
      await cp(path.join(project, "packaging", file), path.join(fixture, file));
    }
    await writeFile(path.join(fixture, "orbital-lab.cjs"), stub);
    port = await freePort();
  });
  afterEach(async () => {
    await call(["stop"]);
    await rm(recordFile(), { force: true });
  });
  afterAll(async () => {
    if (fixture) {
      await call(["stop"]);
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it("starts, reports health, writes a record, and stops from another directory", async () => {
    const started = await call(["start"]);
    expect(started, started.text).toMatchObject({ code: 0 });
    expect(Number.isInteger((await health()).pid)).toBe(true);
    await access(recordFile());
    const stopped = await call(["stop"]);
    expect(stopped, stopped.text).toMatchObject({ code: 0 });
    await expect(access(recordFile())).rejects.toBeDefined();
    expect((await call(["stop"])).code).toBe(0);
  }, 60000);
  it("restarts when invoked without arguments", async () => {
    expect((await call([])).code).toBe(0);
    const first = (await health()).pid;
    const restarted = await call([]);
    expect(restarted, restarted.text).toMatchObject({ code: 0 });
    expect((await health()).pid).not.toBe(first);
  }, 60000);
  it("restarts on a different port and records the new port", async () => {
    expect((await call(["start"])).code).toBe(0);
    const first = (await health()).pid;
    const next = await freePort();
    const restarted = await call(["restart"], { PORT: String(next) });
    expect(restarted, restarted.text).toMatchObject({ code: 0 });
    expect((await health(next)).pid).not.toBe(first);
    expect(JSON.parse(await readFile(recordFile(), "utf8")).port).toBe(next);
  }, 60000);
  it("reports an existing instance instead of starting a second one", async () => {
    expect((await call(["start"])).code).toBe(0);
    const pid = (await health()).pid;
    const repeated = await call(["start"], { PORT: String(await freePort()) });
    expect(repeated.code).toBe(0);
    expect(repeated.text).toContain("already running");
    expect((await health()).pid).toBe(pid);
  }, 60000);
  it("fails on a port conflict without recording an instance", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
    try {
      const result = await call(["start"]);
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("already in use");
      await expect(access(recordFile())).rejects.toBeDefined();
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 60000);
  it("rejects invalid actions and ports without recording an instance", async () => {
    expect((await call(["status"])).code).toBe(2);
    for (const PORT of ["0", "65536", "abc"]) {
      const result = await call(["start"], { PORT });
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("PORT must be");
    }
    await expect(access(recordFile())).rejects.toBeDefined();
  }, 60000);
  it("refuses to stop or restart a process it cannot verify", async () => {
    const record = {
      version: 1,
      pid: process.pid,
      port: await freePort(),
      node: process.execPath,
      entry: path.join(fixture, "orbital-lab.cjs"),
      root: fixture,
      startedAt: new Date().toISOString(),
    };
    await writeFile(recordFile(), JSON.stringify(record));
    for (const action of ["stop", "restart"]) {
      const result = await call([action]);
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("Refusing");
    }
    await access(recordFile());
  }, 60000);
  it("cleans a dead record and refuses to parse a corrupt one", async () => {
    await writeFile(
      recordFile(),
      JSON.stringify({
        version: 1,
        pid: 2147483647,
        port,
        node: process.execPath,
        entry: path.join(fixture, "orbital-lab.cjs"),
        root: fixture,
        startedAt: new Date().toISOString(),
      }),
    );
    const started = await call(["start"]);
    expect(started, started.text).toMatchObject({ code: 0 });
    expect(Number.isInteger((await health()).pid)).toBe(true);
    expect((await call(["stop"])).code).toBe(0);
    await writeFile(recordFile(), "{broken");
    const result = await call(["stop"]);
    expect(result.code).not.toBe(0);
    expect(result.text).toContain("Cannot validate");
    await access(recordFile());
  }, 60000);
});
