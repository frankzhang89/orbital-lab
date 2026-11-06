import { i18n } from "./index";
import { resolveLanguage } from "./languages";

const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const locale = resolveLanguage(i18n.resolvedLanguage).formatLocale, key = `${locale}:${digits}`;
  let formatter = numbers.get(key);
  if (!formatter) { formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }); numbers.set(key, formatter); }
  return formatter.format(value);
}
export function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const locale = resolveLanguage(i18n.resolvedLanguage).formatLocale;
  let formatter = dates.get(locale);
  if (!formatter) { formatter = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }); dates.set(locale, formatter); }
  return formatter.format(date);
}
