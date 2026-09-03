import { en } from "./en";
import { ja } from "./ja";
import type { UiText } from "./types";

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ja";
export const LOCALE_STORAGE_KEY = "aonote:locale:v1";

const localeTexts: Record<Locale, UiText> = { ja, en };

export function isLocale(value: string | null): value is Locale {
  return value !== null && SUPPORTED_LOCALES.includes(value as Locale);
}

export function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function persistLocale(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Keep the locale for the current session when localStorage is unavailable.
  }
}

export function getUiText(locale: Locale): UiText {
  return localeTexts[locale];
}

export function applyLocaleMetadata(locale: Locale) {
  const text = getUiText(locale);
  document.documentElement.lang = text.meta.language;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", text.meta.description);
}

export type { UiText } from "./types";
