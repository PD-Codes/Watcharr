import enUS from './en-US.json';

// v1 ships US English only. Add locales here and pick one per request when needed.
const locales = { 'en-US': enUS } as const;
export type Locale = keyof typeof locales;
export const DEFAULT_LOCALE: Locale = 'en-US';

export type TranslationKey = keyof typeof enUS;

export function t(key: TranslationKey, locale: Locale = DEFAULT_LOCALE): string {
  return locales[locale][key] ?? key;
}
