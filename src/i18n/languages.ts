export const namespaces = ["common", "sandbox", "help", "errors"] as const;
export type Namespace = typeof namespaces[number];
export type LanguageBundle = Partial<Record<Namespace, Record<string, string>>>;
export interface LanguageRegistration {
  code: string;
  nativeName: string;
  formatLocale: string;
  enabled: boolean;
  load?: () => Promise<LanguageBundle>;
}

// A language becomes selectable only when its bundled resources are ready.
// Add a directory, a loader and enabled registration to introduce another language.
export const languages: readonly LanguageRegistration[] = [
  { code: "en", nativeName: "English", formatLocale: "en-US", enabled: true },
  {
    code: "zh-CN", nativeName: "简体中文", formatLocale: "zh-CN", enabled: true,
    load: async () => {
      const [common, sandbox, help, errors] = await Promise.all([
        import("./locales/zh-CN/common.json"), import("./locales/zh-CN/sandbox.json"),
        import("./locales/zh-CN/help.json"), import("./locales/zh-CN/errors.json"),
      ]);
      return { common: common.default, sandbox: sandbox.default, help: help.default, errors: errors.default };
    },
  },
  { code: "fr", nativeName: "Français", formatLocale: "fr-FR", enabled: false },
];

export const LANGUAGE_STORAGE_KEY = "orbital-lab.language";
export const selectableLanguages = languages.filter((language) => language.enabled);
export function resolveLanguage(code: string | null | undefined): LanguageRegistration {
  return languages.find((language) => language.code === code && language.enabled) ?? languages.find((language) => language.code === "en")!;
}
export function readLanguage(storage?: Pick<Storage, "getItem">): string {
  try { return resolveLanguage(storage?.getItem(LANGUAGE_STORAGE_KEY)).code; }
  catch { return "en"; }
}
