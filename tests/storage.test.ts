import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { DEFAULT_SCENE } from "../src/defaults";
import { ConfigurationStore } from "../server/store";
import { createApp } from "../server/app";
import { createOrbiter, circularSpeed } from "../src/physics/core";
import { norm, sub } from "../src/physics/vector";

let directory: string;
let file: string;
let store: ConfigurationStore;
let server: Server | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "orbital-lab-"));
  file = path.join(directory, "celestial-configs.json");
  store = new ConfigurationStore(file);
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});
const input = (name = "Earth system") => ({
  ...structuredClone(DEFAULT_SCENE),
  name,
});

describe("atomic local configuration store", () => {
  it("returns an empty library without creating a missing file", async () => {
    expect(await store.list()).toEqual([]);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("saves, overwrites, saves as, and survives a new store instance", async () => {
    await store.put("one", input());
    await store.put("one", input("Updated"));
    await store.put("two", input("Copy"));
    const reopened = new ConfigurationStore(file);
    expect((await reopened.list()).map((c) => c.name)).toEqual([
      "Updated",
      "Copy",
    ]);
    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.version).toBe(2);
    expect(disk.configurations[0].orbiters).toHaveLength(3);
    expect(disk.configurations[0].updatedAt).toBeTruthy();
  });
  it("serializes concurrent writes without losing entries", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.put(`item-${i}`, input(String(i))),
      ),
    );
    expect(await store.list()).toHaveLength(20);
  });
  it("reads version 1 without writing, preserves clockwise states, and backs up before the first version 2 write", async () => {
    const legacy = { version: 1, configurations: [{ id: "old", name: "Legacy", updatedAt: "2026-01-01T00:00:00.000Z", central: DEFAULT_SCENE.central,
      orbiters: [false, true].map((clockwise, i) => ({ id: String(i), name: `Old ${i}`, color: "#abcdef", altitude: 800000, phase: 57, clockwise })) }] };
    const original = JSON.stringify(legacy);
    await writeFile(file, original);
    const records = await store.list();
    expect(await readFile(file, "utf8")).toBe(original);
    await expect(readFile(`${file}.v1.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    records[0].orbiters.forEach((o, i) => {
      const b = createOrbiter(o, DEFAULT_SCENE.central), a = 57 * Math.PI / 180, r = DEFAULT_SCENE.central.radius + 800000;
      const v = circularSpeed(DEFAULT_SCENE.central, 800000) * (i === 1 ? -1 : 1);
      expect(norm(sub(b.position, [r * Math.cos(a), r * Math.sin(a), 0]))).toBeLessThan(1e-6);
      expect(norm(sub(b.velocity, [-v * Math.sin(a), v * Math.cos(a), 0]))).toBeLessThan(1e-8);
    });
    await store.put("new", input());
    expect(await readFile(`${file}.v1.bak`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
    expect(await new ConfigurationStore(file).list()).toHaveLength(2);
    await store.delete("new");
    expect(await readFile(`${file}.v1.bak`, "utf8")).toBe(original);
  });
  it("preserves the original if its version 1 backup cannot be safely written", async () => {
    const original = JSON.stringify({ version: 1, configurations: [] });
    await writeFile(file, original); await writeFile(`${file}.v1.bak`, "existing different backup");
    await expect(store.put("new", input())).rejects.toThrow("Unable to save");
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readFile(`${file}.v1.bak`, "utf8")).toBe("existing different backup");
  });
  it("validates three-dimensional orbital angles", async () => {
    for (const change of [{ inclination: -1 }, { inclination: 181 }, { inclination: NaN }, { ascendingNode: 361 }])
      await expect(store.put("invalid", { ...input(), orbiters: [{ ...DEFAULT_SCENE.orbiters[0], ...change }] })).rejects.toMatchObject({ status: 400 });
    const saved = await store.put("polar", { ...input(), orbiters: [{ ...DEFAULT_SCENE.orbiters[0], inclination: 90, ascendingNode: 237 }] });
    expect(saved.orbiters[0].inclination).toBe(90);
    expect((await new ConfigurationStore(file).list())[0].orbiters[0].ascendingNode).toBe(237);
  });
  it("deletes exactly one configuration and reports a missing ID", async () => {
    await store.put("one", input());
    await store.put("two", input("Other"));
    await store.delete("one");
    expect((await store.list()).map((c) => c.id)).toEqual(["two"]);
    await expect(store.delete("missing")).rejects.toMatchObject({
      status: 404,
    });
  });
  it("preserves damaged and future-version files on reads and writes", async () => {
    for (const contents of ["{broken", '{"version":99,"configurations":[]}']) {
      await writeFile(file, contents);
      await expect(store.list()).rejects.toThrow("preserved");
      await expect(store.put("one", input())).rejects.toThrow("preserved");
      await expect(store.delete("one")).rejects.toThrow("preserved");
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  });
  it("validates values, IDs, unknown fields and duplicate spacecraft IDs", async () => {
    await expect(store.put("../unsafe", input())).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      store.put("one", {
        ...input(),
        central: { ...DEFAULT_SCENE.central, mass: -1 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.put("one", { ...input(), time: 100 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.put("one", {
        ...input(),
        orbiters: [DEFAULT_SCENE.orbiters[0], DEFAULT_SCENE.orbiters[0]],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await store.list()).toEqual([]);
  });
  it("reports write failures without pretending the configuration was saved", async () => {
    const invalid = new ConfigurationStore(
      path.join(directory, "missing-directory", "celestial-configs.json"),
    );
    await expect(invalid.put("one", input())).rejects.toThrow("Unable to save");
  });
});

describe("local HTTP API", () => {
  it("exercises the full API lifecycle and rejects invalid JSON and cross-origin writes", async () => {
    server = createApp(store).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const list = await fetch(`${base}/api/configurations`);
    expect(list.status).toBe(200);
    expect((await list.json()).configurations).toEqual([]);
    const saved = await fetch(`${base}/api/configurations/test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).id).toBe("test");
    const malformed = await fetch(`${base}/api/configurations/test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
    const crossOrigin = await fetch(`${base}/api/configurations/test`, {
      method: "DELETE",
      headers: { Origin: "https://unrelated.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const deleted = await fetch(`${base}/api/configurations/test`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(
      (await (await fetch(`${base}/api/configurations`)).json()).configurations,
    ).toEqual([]);
  });
});
