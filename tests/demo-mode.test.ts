import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { readAppSettings } from "../server/settings";
import { createApp } from "../server/app";
import { ConfigurationStore } from "../server/store";
import { DEFAULT_SCENE } from "../src/defaults";
import { isAppSettings } from "../src/settings";
import { changeLanguage, msg, renderMessage } from "../src/i18n";
import { errorMessage } from "../src/i18n/messages";

let directory: string;
let server: Server | undefined;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "orbital-demo-")); });
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  await changeLanguage("en");
  await rm(directory, { recursive: true, force: true });
});
async function serve(store: ConfigurationStore, demoMode: boolean) {
  server = createApp(store, { demoMode }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const input = { ...DEFAULT_SCENE, name: "Demo fixture" };

describe("project startup settings", () => {
  it("defaults a missing file to normal mode without creating it", async () => {
    expect(await readAppSettings(path.join(directory, "app-config.json"))).toEqual({ demoMode: false });
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([true, false])("reads demoMode=%s without rewriting the file", async (demoMode) => {
    const file = path.join(directory, "app-config.json");
    const original = `  { "demoMode": ${demoMode} }\n`;
    await writeFile(file, original);
    expect(await readAppSettings(file)).toEqual({ demoMode });
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("uses the default for an omitted setting and accepts a UTF-8 BOM", async () => {
    const file = path.join(directory, "app-config.json");
    await writeFile(file, "{}");
    expect(await readAppSettings(file)).toEqual({ demoMode: false });
    await writeFile(file, '\uFEFF{"demoMode":true}');
    expect(await readAppSettings(file)).toEqual({ demoMode: true });
  });
  it.each(['{broken', '{"demoMode":"true"}', '{"demoMode":1}', '{"demoMode":null}', '[]', 'null', '{"demoMod":true}'])
    ("rejects invalid settings without replacing the original: %s", async (original) => {
      const file = path.join(directory, "app-config.json");
      await writeFile(file, original);
      await expect(readAppSettings(file)).rejects.toThrow("Invalid app-config.json");
      expect(await readFile(file, "utf8")).toBe(original);
    });
  it("reports read failures instead of silently enabling writes", async () => {
    const file = path.join(directory, "app-config.json");
    await mkdir(file);
    await expect(readAppSettings(file)).rejects.toThrow("Unable to read app-config.json");
    expect(await readdir(file)).toEqual([]);
  });
  it("rejects malformed server responses on the client", () => {
    expect(isAppSettings({ demoMode: true })).toBe(true);
    expect(isAppSettings({ demoMode: false })).toBe(true);
    for (const value of [null, {}, [], true, { demoMode: "false" }]) expect(isAppSettings(value)).toBe(false);
  });
});

describe("demo configuration API", () => {
  it.each([true, false])("exposes the active demoMode=%s with no caching", async (demoMode) => {
    const base = await serve(new ConfigurationStore(path.join(directory, "celestial-configs.json")), demoMode);
    const response = await fetch(`${base}/api/settings`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ demoMode });
  });
  it("keeps normal-mode save, overwrite, save-as and delete available", async () => {
    const store = new ConfigurationStore(path.join(directory, "celestial-configs.json"));
    const base = await serve(store, false);
    for (const [id, name] of [["one", "Original"], ["one", "Updated"], ["two", "Copy"]]) {
      const response = await fetch(`${base}/api/configurations/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, name }),
      });
      expect(response.status).toBe(200);
    }
    expect((await store.list()).map((c) => c.name)).toEqual(["Updated", "Copy"]);
    expect((await fetch(`${base}/api/configurations/one`, { method: "DELETE" })).status).toBe(204);
    expect((await store.list()).map((c) => c.id)).toEqual(["two"]);
  });
  it.each(["missing", "legacy", "damaged"])("blocks writes before storage access and preserves %s files", async (kind) => {
    const file = path.join(directory, "celestial-configs.json");
    if (kind === "legacy") {
      await writeFile(file, JSON.stringify({ version: 1, configurations: [{
        ...input, id: "saved", updatedAt: "2026-01-01T00:00:00.000Z",
        orbiters: DEFAULT_SCENE.orbiters.map(({ inclination, ascendingNode, ...orbiter }) => ({ ...orbiter, clockwise: false })),
      }] }));
      await writeFile(`${file}.v1.bak`, "existing backup bytes");
    } else if (kind === "damaged") await writeFile(file, "{damaged");
    const before = await Promise.all((await readdir(directory)).map(async (name) => [name, await readFile(path.join(directory, name), "utf8")]));
    const store = new ConfigurationStore(file);
    const put = vi.spyOn(store, "put");
    const remove = vi.spyOn(store, "delete");
    const base = await serve(store, true);
    // Include overwrite, save-as, deletion and invalid JSON: every write is forbidden.
    for (const [method, id, body] of [["PUT", "saved", JSON.stringify(input)], ["PUT", "new", JSON.stringify(input)], ["PUT", "new", "{broken"], ["DELETE", "saved", undefined]]) {
      const response = await fetch(`${base}/api/configurations/${id}`, {
        method, body, headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "DEMO_MODE_READ_ONLY", error: "Configurations are read-only in demo mode." });
    }
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const list = await fetch(`${base}/api/configurations`);
    expect(list.status).toBe(kind === "damaged" ? 500 : 200);
    if (kind !== "damaged") expect((await list.json()).configurations).toHaveLength(kind === "legacy" ? 1 : 0);
    const after = await Promise.all((await readdir(directory)).map(async (name) => [name, await readFile(path.join(directory, name), "utf8")]));
    expect(after).toEqual(before);
  });
  it("translates read-only and settings-failure messages when the language changes", async () => {
    const notice = msg("common:settingsUnavailable");
    const forbidden = errorMessage({ code: "DEMO_MODE_READ_ONLY" });
    expect(renderMessage(forbidden)).toBe("Configurations are read-only in demo mode.");
    expect(renderMessage(notice)).toContain("Unable to load");
    await changeLanguage("zh-CN");
    expect(renderMessage(forbidden)).toBe("演示模式下配置库为只读。");
    expect(renderMessage(notice)).toContain("无法读取应用设置");
  });
});
