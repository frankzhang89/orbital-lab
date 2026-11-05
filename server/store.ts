import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SavedConfiguration } from "../src/types";

const name = z.string().trim().min(1).max(80);
const finite = z.number().finite();
export const centralSchema = z
  .object({
    name,
    mass: finite.min(1e10).max(1e32),
    radius: finite.min(1).max(1e10),
  })
  .strict();
export const orbiterSchema = z
  .object({
    id: z.string().min(1).max(100),
    name,
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    altitude: finite.min(1).max(1e12),
    phase: finite.min(0).max(360),
    inclination: finite.min(0).max(180),
    ascendingNode: finite.min(0).max(360),
  })
  .strict();
export const configurationInputSchema = z
  .object({
    name,
    central: centralSchema,
    orbiters: z.array(orbiterSchema).max(500),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.orbiters.map((o) => o.id)).size === value.orbiters.length,
    { message: "Spacecraft IDs must be unique." },
  );
const savedSchema = z
  .object({
    id: z.string().min(1).max(100),
    updatedAt: z.iso.datetime(),
    name,
    central: centralSchema,
    orbiters: z.array(orbiterSchema).max(500),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.orbiters.map((o) => o.id)).size === value.orbiters.length,
    { message: "Spacecraft IDs must be unique." },
  );
const fileSchema = z
  .object({
    version: z.literal(2),
    configurations: z.array(savedSchema).max(500),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.configurations.map((c) => c.id)).size ===
      value.configurations.length,
    { message: "Configuration IDs must be unique." },
  );

const legacyOrbiter = orbiterSchema.omit({ inclination: true, ascendingNode: true }).extend({ clockwise: z.boolean() }).strict();
const legacySaved = z.object({
  id: z.string().min(1).max(100), updatedAt: z.iso.datetime(), name,
  central: centralSchema, orbiters: z.array(legacyOrbiter).max(500),
}).strict().refine((value) => new Set(value.orbiters.map((o) => o.id)).size === value.orbiters.length);
const legacyFile = z.object({ version: z.literal(1), configurations: z.array(legacySaved).max(500) }).strict()
  .refine((value) => new Set(value.configurations.map((c) => c.id)).size === value.configurations.length);

export class StoreError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

export class ConfigurationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private legacyRaw?: string;
  constructor(readonly filePath: string) {}

  async list(): Promise<SavedConfiguration[]> {
    await this.queue.catch(() => undefined);
    return this.read();
  }
  private async read(): Promise<SavedConfiguration[]> {
    this.legacyRaw = undefined;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(
        "Unable to read celestial-configs.json. Check file permissions.",
      );
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version === 1) {
        const legacy = legacyFile.parse(parsed);
        this.legacyRaw = raw;
        return legacy.configurations.map((c) => ({ ...c, orbiters: c.orbiters.map(({ clockwise, ...orbiter }) => ({
          ...orbiter, inclination: clockwise ? 180 : 0, ascendingNode: 0,
          phase: clockwise ? ((-orbiter.phase % 360) + 360) % 360 : orbiter.phase,
        })) }));
      }
      return fileSchema.parse(parsed).configurations;
    } catch {
      throw new StoreError(
        "celestial-configs.json is damaged or uses an unsupported format. The file has been preserved.",
      );
    }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(action);
    this.queue = next;
    return next;
  }
  private async write(configurations: SavedConfiguration[]) {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      if (this.legacyRaw !== undefined) {
        const backup = `${this.filePath}.v1.bak`;
        try {
          await writeFile(backup, this.legacyRaw, { encoding: "utf8", flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(backup, "utf8") !== this.legacyRaw)
            throw new Error("Unable to preserve the version 1 configuration backup.");
        }
      }
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 2, configurations }, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, this.filePath);
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      throw new StoreError(
        "Unable to save celestial-configs.json. Check disk space and file permissions.",
      );
    }
  }
  put(id: string, input: unknown): Promise<SavedConfiguration> {
    const parsed = configurationInputSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(
        new StoreError(
          "Invalid configuration. Check names, masses, radii, altitudes, phases, inclinations and ascending nodes.",
          400,
        ),
      );
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      return Promise.reject(new StoreError("Invalid configuration ID.", 400));
    return this.serialize(async () => {
      const configurations = await this.read();
      const record = {
        ...parsed.data,
        id,
        updatedAt: new Date().toISOString(),
      };
      const index = configurations.findIndex((c) => c.id === id);
      if (index >= 0) configurations[index] = record;
      else {
        if (configurations.length >= 500)
          throw new StoreError("The configuration library is full.", 400);
        configurations.push(record);
      }
      await this.write(configurations);
      return record;
    });
  }
  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const configurations = await this.read();
      if (!configurations.some((c) => c.id === id))
        throw new StoreError("Configuration not found.", 404);
      await this.write(configurations.filter((c) => c.id !== id));
    });
  }
}
