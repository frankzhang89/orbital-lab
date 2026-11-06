import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../src/settings";

const schema = z.object({ demoMode: z.boolean().default(false) }).strict();

/** Read once at startup; only a missing file uses defaults. Never rewrite it. */
export async function readAppSettings(file: string): Promise<AppSettings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_APP_SETTINGS };
    throw new Error(`Unable to read app-config.json (${file}). Check file permissions.`, { cause: error });
  }
  try {
    return schema.parse(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (error) {
    throw new Error(`Invalid app-config.json (${file}). Expected a JSON object with a boolean demoMode setting.`, { cause: error });
  }
}
