import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";

const windows = process.platform === "win32";
const supported = windows || process.platform === "linux";
const project = process.cwd();
let fixture: string;
let port: number;
const recordName = windows ? "server-windows.json" : "server-linux.pid";
const scripts = ["orbital-lab.cmd", "orbital-lab.ps1", "orbital-lab.sh"];
const recordFile = () => path.join(fixture, ".runtime", recordName);
const call = (action: string, override: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; text: string }>((resolve) => {
  const executable = windows ? "powershell.exe" : "bash";
  const args = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture, "orbital-lab.ps1"), action]
    : [path.join(fixture, "orbital-lab.sh"), action];
  execFile(executable, args, { cwd: tmpdir(), env: { ...process.env, PORT: String(port), ...override }, timeout: 45000, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, text: stdout + stderr });
  });
});
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const value = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return value;
}
async function pidRecord() {
  const data = await readFile(recordFile(), "utf8");
  return windows ? JSON.parse(data).pid as number : Number(data.split(" ")[0]);
}

describe.skipIf(!supported)("production launcher integration (isolated project copy)", () => {
  beforeAll(async () => {
    // Resolve 8.3 short names: Windows CI runners report a short %TEMP%, while the
    // PowerShell launcher stores the expanded long path in its process record.
    fixture = await realpath(await mkdtemp(path.join(tmpdir(), "orbital launch 空格测试-")));
    for (const item of ["src", "server", "package.json", ...scripts]) await cp(path.join(project, item), path.join(fixture, item), { recursive: true });
    // A fixture-only fault switch exercises an unhealthy existing process without changing production code.
    const appFile = path.join(fixture, "server/app.ts");
    const appSource = await readFile(appFile, "utf8");
    await writeFile(appFile, 'import { existsSync } from "node:fs";\n' + appSource.replace(
      'app.get("/api/settings", (_req, res) => {',
      'app.get("/api/settings", (_req, res) => { if (existsSync(new URL("../settings-unhealthy", import.meta.url))) { res.sendStatus(503); return; }',
    ));
    await symlink(path.join(project, "node_modules"), path.join(fixture, "node_modules"), windows ? "junction" : "dir");
    await mkdir(path.join(fixture, "dist"));
    await writeFile(path.join(fixture, "dist/index.html"), "<!doctype html><title>Launcher fixture</title>");
    await writeFile(path.join(fixture, "app-config.json"), '{"demoMode":false}');
    await writeFile(path.join(fixture, "celestial-configs.json"), '{"version":2,"configurations":[]}');
    port = await freePort();
  });
  afterEach(async () => {
    await call("stop");
    await writeFile(path.join(fixture, "app-config.json"), '{"demoMode":false}');
    expect(await readFile(path.join(fixture, "celestial-configs.json"), "utf8")).toBe('{"version":2,"configurations":[]}');
  });
  afterAll(async () => {
    if (fixture) {
      await call("stop");
      // Remove the dependency link explicitly before recursive fixture cleanup.
      await rm(path.join(fixture, "node_modules"), { force: true, recursive: windows });
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it("starts from another directory, survives its control process, and handles repeated start/stop", async () => {
    const first = await call("start");
    expect(first, first.text).toMatchObject({ code: 0 });
    expect(first.text).toContain(`http://127.0.0.1:${port}`);
    const pid = await pidRecord();
    expect(await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()).toEqual({ demoMode: false });
    const repeated = await call("start", { PORT: String(await freePort()) });
    expect(repeated.code, repeated.text).toBe(0);
    expect(repeated.text).toContain("already running");
    expect(await pidRecord()).toBe(pid);
    expect((await call("stop")).code).toBe(0);
    await expect(access(recordFile())).rejects.toBeDefined();
    expect((await call("stop")).code).toBe(0);
  }, 60000);
  it("restarts with a changed port, reloads demo settings, and appends rather than replaces logs", async () => {
    expect((await call("start")).code).toBe(0);
    const oldPid = await pidRecord();
    const log = path.join(fixture, ".runtime", windows ? "stdout-windows.log" : "stdout-linux.log");
    const before = await readFile(log, "utf8");
    await writeFile(path.join(fixture, "app-config.json"), '{"demoMode":true}');
    const nextPort = await freePort();
    const restarted = await call("restart", { PORT: String(nextPort) });
    expect(restarted.code, restarted.text).toBe(0);
    expect(await pidRecord()).not.toBe(oldPid);
    expect(await (await fetch(`http://127.0.0.1:${nextPort}/api/settings`)).json()).toEqual({ demoMode: true });
    const forbidden = await fetch(`http://127.0.0.1:${nextPort}/api/configurations/new`, { method: "PUT" });
    expect(forbidden.status).toBe(403);
    expect((await readFile(log, "utf8")).startsWith(before)).toBe(true);
    expect((await readFile(log, "utf8")).length).toBeGreaterThan(before.length);
  }, 60000);
  it("refuses a second instance when the managed server becomes unhealthy", async () => {
    const started = await call("start");
    expect(started.code, started.text).toBe(0);
    const pid = await pidRecord();
    const fault = path.join(fixture, "settings-unhealthy");
    await writeFile(fault, "fixture-only fault");
    try {
      const result = await call("start");
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("not healthy");
      expect(await pidRecord()).toBe(pid);
    } finally { await rm(fault, { force: true }); }
  }, 60000);
  it("refuses an occupied port without stopping its owner", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const used = (listener.address() as { port: number }).port;
      const result = await call("start", { PORT: String(used) });
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("already in use");
      expect(listener.listening).toBe(true);
      await expect(access(recordFile())).rejects.toBeDefined();
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }
  }, 60000);
  it("cleans a dead PID record but refuses a live process with the wrong identity", async () => {
    const stale = windows ? JSON.stringify({ version: 1, pid: 2147483647, startTicks: "1", port, project: fixture, node: process.execPath })
      : `2147483647 1 ${port}\n${fixture}\n${process.execPath}\n`;
    await mkdir(path.join(fixture, ".runtime"), { recursive: true });
    await writeFile(recordFile(), stale);
    expect((await call("start")).code).toBe(0);
    expect((await call("stop")).code).toBe(0);
    const unrelated = windows ? JSON.stringify({ version: 1, pid: process.pid, startTicks: "1", port, project: fixture, node: process.execPath })
      : `${process.pid} 1 ${port}\n${fixture}\n${process.execPath}\n`;
    await writeFile(recordFile(), unrelated);
    try {
      for (const action of ["stop", "start", "restart"]) {
        const result = await call(action);
        expect(result.code).not.toBe(0);
        expect(result.text).toContain("identity");
      }
      expect(await readFile(recordFile(), "utf8")).toBe(unrelated);
      expect(process.kill(process.pid, 0)).toBe(true);
    } finally { await rm(recordFile(), { force: true }); }
  }, 60000);
  it("rejects invalid arguments and ports without creating an instance", async () => {
    expect((await call("status")).code).toBe(2);
    for (const PORT of ["0", "65536", "-1", "abc", "1.5"]) {
      const result = await call("start", { PORT });
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("PORT must be");
    }
    await expect(access(recordFile())).rejects.toBeDefined();
  }, 60000);
  it("reports corrupt settings and startup failure without retaining a process record", async () => {
    await writeFile(path.join(fixture, "app-config.json"), "{broken");
    const result = await call("start");
    expect(result.code).not.toBe(0);
    expect(result.text).toContain(".log");
    await expect(access(recordFile())).rejects.toBeDefined();
    expect(await readFile(path.join(fixture, ".runtime", windows ? "stderr-windows.log" : "stderr-linux.log"), "utf8")).toContain("Invalid app-config.json");
  }, 60000);
  it("reports missing dependencies and build without silently preparing them", async () => {
    const { rename } = await import("node:fs/promises");
    await rename(path.join(fixture, "dist/index.html"), path.join(fixture, "dist/index.hidden"));
    try { const result = await call("start"); expect(result.code).not.toBe(0); expect(result.text).toContain("run build"); }
    finally { await rename(path.join(fixture, "dist/index.hidden"), path.join(fixture, "dist/index.html")); }
    await rename(path.join(fixture, "node_modules"), path.join(fixture, "dependencies-hidden"));
    try { const result = await call("start"); expect(result.code).not.toBe(0); expect(result.text).toContain("ci"); }
    finally { await rename(path.join(fixture, "dependencies-hidden"), path.join(fixture, "node_modules")); }
  }, 60000);
  it("serializes simultaneous start commands so only one instance is managed", async () => {
    const results = await Promise.all([call("start"), call("start")]);
    expect(results.filter((result) => result.code === 0).length).toBeGreaterThanOrEqual(1);
    for (const result of results.filter((result) => result.code !== 0)) expect(result.text).toContain("control command");
    expect((await call("start")).text).toContain("already running");
    expect((await fetch(`http://127.0.0.1:${port}/api/settings`)).status).toBe(200);
  }, 60000);
});
