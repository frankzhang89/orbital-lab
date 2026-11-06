/** Public, language-neutral settings supplied by the local server. */
export interface AppSettings {
  demoMode: boolean;
}
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ demoMode: false });
export function isAppSettings(value: unknown): value is AppSettings {
  return typeof value === "object" && value !== null &&
    typeof (value as AppSettings).demoMode === "boolean";
}
