import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { changeLanguage, createTranslator, english, i18n, languageController, msg, renderMessage, tx } from "../src/i18n";
import { languages, LANGUAGE_STORAGE_KEY, namespaces, readLanguage, resolveLanguage, selectableLanguages, type LanguageBundle, type LanguageRegistration } from "../src/i18n/languages";
import { SI } from "../src/i18n/units";
import { formatDate, formatNumber } from "../src/i18n/format";
import { bodyName, cutoffLabel, errorMessage, requestError } from "../src/i18n/messages";
import { DomainError, errorDiagnostics, toErrorPayload } from "../src/messages";
import { DEFAULT_LAUNCH, DEFAULT_SCENE, EARTH } from "../src/defaults";
import { createLaunch, createOrbiter, advanceBody } from "../src/physics/core";
import { planPlaneChange } from "../src/physics/planeChange";
import { advanceSimulation, schedulePlaneChange } from "../src/physics/timeline";
import type { Snapshot } from "../src/types";

const chinese = async () => languages.find((l) => l.code === "zh-CN")!.load!();
const placeholders = (value: string) => [...value.matchAll(/{{\s*([^},]+)(?:,[^}]*)?\s*}}/g)].map((m) => m[1].trim()).sort();
afterEach(async () => { await changeLanguage("en"); });

describe("bundled translation completeness", () => {
  it("includes every English key, nonempty text and matching interpolation parameters in enabled languages", async () => {
    for (const language of selectableLanguages) {
      const bundle: LanguageBundle = language.code === "en" ? english : await language.load!();
      for (const ns of namespaces) {
        expect(Object.keys(bundle[ns]!).sort()).toEqual(Object.keys(english[ns]).sort());
        for (const [key, value] of Object.entries(english[ns])) {
          expect(bundle[ns]![key]?.trim(), `${language.code}/${ns}/${key}`).toBeTruthy();
          expect(placeholders(bundle[ns]![key])).toEqual(placeholders(value));
        }
      }
    }
  });
  it("has translations for all shared error codes and stable cutoff reasons", async () => {
    expect(Object.keys(english.errors).sort()).toEqual(Object.keys(errorDiagnostics).sort());
    await changeLanguage("zh-CN");
    expect(cutoffLabel("fuelDepleted")).toBe("燃料耗尽");
    expect(cutoffLabel("burnTimeReached")).toBe("达到工作时间");
    expect(cutoffLabel("surfaceImpact")).toBe("撞击地面");
    expect(cutoffLabel("engineStopped")).toBe("发动机已停止");
  });
  it("uses correct singular and plural forms rather than concatenating fragments", async () => {
    expect(tx("sandbox:activeBodies", { count: 1 })).toBe("1 active body");
    expect(tx("sandbox:activeBodies", { count: 2 })).toBe("2 active bodies");
    await changeLanguage("zh-CN");
    expect(tx("sandbox:activeBodies", { count: 0 })).toBe("0 个活动物体");
    expect(tx("sandbox:activeBodies", { count: 1 })).toBe("1 个活动物体");
    expect(tx("common:spacecraftCount", { count: 2 })).toBe("2 个飞行器");
  });
  it("keeps French reserved and unselectable, and defaults unsupported preferences to English", () => {
    expect(selectableLanguages.map((l) => l.code)).toEqual(["en", "zh-CN"]);
    expect(languages.find((l) => l.code === "fr")).toMatchObject({ nativeName: "Français", enabled: false });
    for (const code of [undefined, null, "", "fr", "fr-FR", "unknown"]) expect(resolveLanguage(code).code).toBe("en");
  });
  it("prevents newly added untranslated visible JSX or labels in existing UI surfaces", () => {
    const allowed = new Set(["ORBITAL", "LAB", "T+", "· T−", "TWR"]);
    for (const file of ["src/App.tsx", "src/components/Universe.tsx", "src/components/TextSizeSettings.tsx", "src/components/LanguageSettings.tsx"]) {
      const source = readFileSync(file, "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.replace(/\s+/g, " ").trim();
          if (/[A-Za-z]/.test(text)) expect(allowed.has(text), `${file}: untranslated ${text}`).toBe(true);
        }
        if (ts.isJsxAttribute(node) && ["label", "title", "aria-label", "placeholder"].includes(node.name.getText(tree)) && node.initializer && ts.isStringLiteral(node.initializer))
          expect(/[A-Za-z]/.test(node.initializer.text), `${file}: untranslated attribute`).toBe(false);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  });
});

describe("language fallback and persistence", () => {
  it("starts in English without reading the browser's preferred language", () => {
    expect(createTranslator().resolvedLanguage).toBe("en");
    expect(readLanguage()).toBe("en");
    expect(readLanguage({ getItem: () => "fr" })).toBe("en");
    expect(readLanguage({ getItem: () => "zh-CN" })).toBe("zh-CN");
  });
  it("remains usable when localStorage reads and writes throw", async () => {
    expect(readLanguage({ getItem: () => { throw new Error("storage unavailable"); } })).toBe("en");
    const instance = createTranslator();
    const select = languageController(instance, { setItem: () => { throw new Error("storage unavailable"); } });
    expect(await select("zh-CN")).toBe("zh-CN");
    expect(instance.t("common:save")).toBe("保存配置");
  });
  it("saves the effective language and reloads the same preference", async () => {
    const saved = new Map<string, string>();
    const select = languageController(createTranslator(), { setItem: (k, v) => saved.set(k, v) });
    await select("zh-CN");
    expect(saved.get(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect(readLanguage({ getItem: (k) => saved.get(k) ?? null })).toBe("zh-CN");
    await select("fr"); expect(saved.get(LANGUAGE_STORAGE_KEY)).toBe("en");
  });
  it("falls back to English when the complete language bundle fails or is empty", async () => {
    for (const load of [async () => { throw new Error("missing chunk"); }, async () => ({ common: {} }) as LanguageBundle]) {
      const instance = createTranslator();
      expect(await languageController(instance)("zh-CN", load)).toBe("en");
      expect(instance.t("common:save")).toBe("Save Configuration");
    }
  });
  it("falls back per key for empty text, missing keys and missing namespaces", async () => {
    const instance = createTranslator();
    await languageController(instance)("zh-CN", async () => ({ common: { save: "", cancel: "取消" } }) as LanguageBundle);
    expect(instance.t("common:cancel")).toBe("取消");
    expect(instance.t("common:save")).toBe("Save Configuration");
    expect(instance.t("common:help")).toBe("Help");
    expect(instance.t("sandbox:orbitalAltitude")).toBe("Orbital altitude");
    const withoutCommon = createTranslator();
    await languageController(withoutCommon)("zh-CN", async () => ({ sandbox: { altitude: "高度" } }));
    expect(withoutCommon.t("sandbox:altitude")).toBe("高度");
    expect(withoutCommon.t("common:save")).toBe("Save Configuration");
  });
  it("does not let a slow language load override a newer selection", async () => {
    const instance = createTranslator();
    const select = languageController(instance);
    let release!: (bundle: LanguageBundle) => void;
    const pending = select("zh-CN", () => new Promise((resolve) => { release = resolve; }));
    await select("en"); release(await chinese());
    expect(await pending).toBe("en");
    expect(instance.resolvedLanguage).toBe("en");
  });
  it("accepts a new registered bundled language without changing translation consumers", async () => {
    const registry = languages as LanguageRegistration[];
    registry.push({ code: "es", nativeName: "Español", formatLocale: "es-ES", enabled: true, load: async () => ({ ...english, common: { ...english.common, save: "Guardar configuración" } }) });
    try {
      const instance = createTranslator();
      expect(await languageController(instance)("es")).toBe("es");
      expect(instance.t("common:save")).toBe("Guardar configuración");
    } finally { registry.pop(); }
  });
});

describe("messages, formats, units and simulation isolation", () => {
  it("retranslates existing notification and dialog references without changing user content", async () => {
    const message = msg("common:loaded", { name: "My orbit <测试>" });
    expect(renderMessage(message)).toContain("Loaded “My orbit <测试>”");
    await changeLanguage("zh-CN");
    expect(renderMessage(message)).toBe("已加载“My orbit <测试>”。模拟已暂停。");
    expect(message.params!.name).toBe("My orbit <测试>");
    expect(bodyName(createOrbiter(DEFAULT_SCENE.orbiters[0], EARTH))).toBe("Odyssey");
    expect(bodyName(createLaunch("launch", DEFAULT_LAUNCH, EARTH))).toBe("发射飞行器");
  });
  it("translates known HTTP and Worker codes and hides unknown diagnostic messages", async () => {
    const error = new DomainError("STALE_PREVIEW");
    const worker = structuredClone(toErrorPayload(error));
    const message = errorMessage(worker);
    await changeLanguage("zh-CN");
    expect(renderMessage(message)).toContain("预览已过期");
    expect(renderMessage(errorMessage(new Error("raw diagnostic")))).toBe("发生意外错误，请重试。");
    expect(renderMessage(errorMessage(requestError({ code: "CONFIG_READ_FAILED", error: "diagnostic" })))).toContain("无法读取 celestial-configs.json");
    expect(requestError({ error: "unrecognized response" }).code).toBe("REQUEST_FAILED");
  });
  it("preserves every unit string and numeric value across languages", async () => {
    const units = JSON.stringify(SI);
    for (const language of ["en", "zh-CN"]) {
      await changeLanguage(language);
      expect(JSON.stringify(SI)).toBe(units);
      expect(Object.values(SI)).toEqual(["m", "km", "kg", "s", "kN", "m/s", "m/s²", "deg", "×10²⁴ kg"]);
      expect(tx("sandbox:idealAcceleration", { value: formatNumber(2.5), unit: SI.acceleration })).toContain("2.5 m/s²");
      expect(tx("common:textSizePreview", { altitude: formatNumber(800), speed: formatNumber(7456, 0), distanceUnit: SI.altitude, speedUnit: SI.speed })).toContain("7,456 m/s");
      expect(formatNumber(NaN)).toBe("—"); expect(formatDate("invalid")).toBe("—");
    }
  });
  it("uses the active locale for dates while leaving the timestamp unchanged", async () => {
    const timestamp = "2026-01-25T00:00:00.000Z";
    const en = formatDate(timestamp);
    await changeLanguage("zh-CN");
    expect(formatDate(timestamp)).not.toBe(en);
    expect(timestamp).toBe("2026-01-25T00:00:00.000Z");
  });
  it("preserves a running finite burn and an armed node plan across language changes", async () => {
    const state: Snapshot = { central: EARTH, bodies: [createOrbiter(DEFAULT_SCENE.orbiters[1], EARTH), createLaunch("launch", DEFAULT_LAUNCH, EARTH)], time: 0, running: true, warp: 100, achievedWarp: 100, revision: 0 };
    advanceBody(state.bodies[1], EARTH, 20);
    schedulePlaneChange(state, planPlaneChange(state.bodies[0], EARTH, 20, state.time, state.revision));
    const saved = structuredClone(state);
    await changeLanguage("zh-CN");
    expect(state).toEqual(saved);
    advanceSimulation(state, 1); advanceSimulation(saved, 1);
    expect(state).toEqual(saved);
    expect(state.pendingPlaneChange).toBeDefined();
    expect(state.bodies[1].launch!.elapsed).toBeGreaterThan(20);
  });
});
