import { createInstance, type i18n as I18n } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import common from "./locales/en/common.json";
import sandbox from "./locales/en/sandbox.json";
import help from "./locales/en/help.json";
import errors from "./locales/en/errors.json";
import { LANGUAGE_STORAGE_KEY, namespaces, readLanguage, resolveLanguage, type LanguageBundle, type LanguageRegistration } from "./languages";

export const english = { common, sandbox, help, errors };
type ResourceKey = { [N in keyof typeof english]: `${N}:${keyof typeof english[N] & string}` }[keyof typeof english];
type PluralBase<K> = K extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}` ? Base : never;
export type TranslationKey = ResourceKey | PluralBase<ResourceKey>;
export type MessageParams = Record<string, string | number>;
export interface MessageRef { key: TranslationKey; params?: MessageParams }
export const msg = (key: TranslationKey, params?: MessageParams): MessageRef => ({ key, params });

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof english;
    keySeparator: false;
    returnNull: false;
  }
}

export function createTranslator(): I18n {
  const instance = createInstance();
  instance.use(initReactI18next);
  void instance.init({
    lng: "en", fallbackLng: "en", resources: { en: english },
    ns: [...namespaces], defaultNS: "common", keySeparator: false,
    initAsync: false, returnEmptyString: false, returnNull: false,
    interpolation: { escapeValue: false }, react: { useSuspense: false },
  });
  return instance;
}
export const i18n = createTranslator();
export const tx = (key: TranslationKey, params?: MessageParams): string => i18n.t(key, params ?? {});
export function renderMessage(message: MessageRef | "" | null | undefined): string {
  return message ? tx(message.key, message.params) : "";
}
export function useLocale() {
  useTranslation([...namespaces], { i18n });
  return i18n.resolvedLanguage ?? "en";
}

export function languageController(instance: I18n, storage?: Pick<Storage, "setItem">) {
  let latestRequest = 0;
  return async (requested: string, load?: LanguageRegistration["load"]): Promise<string> => {
    const request = ++latestRequest;
    let language = resolveLanguage(requested);
    if (language.code !== "en" && !namespaces.some((ns) => instance.hasResourceBundle(language.code, ns))) {
      try {
        const loader = load ?? language.load;
        if (!loader) throw new Error("No bundled language resources.");
        const bundle: LanguageBundle = await loader();
        if (!bundle || !namespaces.some((ns) => bundle[ns] && typeof bundle[ns] === "object" && Object.values(bundle[ns]!).some((v) => typeof v === "string" && v.trim())))
          throw new Error("Empty language bundle.");
        for (const ns of namespaces) {
          const resource = bundle[ns];
          // Missing namespaces and empty entries fall back individually to English.
          if (resource && typeof resource === "object")
            instance.addResourceBundle(language.code, ns, Object.fromEntries(Object.entries(resource).filter(([, v]) => typeof v === "string" && v.trim())), true, true);
        }
      } catch {
        language = resolveLanguage("en");
      }
    }
    if (request !== latestRequest) return instance.resolvedLanguage ?? "en";
    await instance.changeLanguage(language.code);
    try { storage?.setItem(LANGUAGE_STORAGE_KEY, language.code); } catch { /* Session-only selection remains usable. */ }
    return language.code;
  };
}
let storage: Storage | undefined;
try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Browser storage can be disabled. */ }
export const changeLanguage = languageController(i18n, storage);
export function initializeLanguage() { return changeLanguage(readLanguage(storage)); }

function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = i18n.resolvedLanguage ?? "en";
  document.documentElement.dir = "ltr";
  document.title = tx("common:appTitle");
}
i18n.on("languageChanged", updateDocument);
updateDocument();
