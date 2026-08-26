import enUS from './en-US.json';
import deDE from './de-DE.json';

// One flat dictionary per locale. Flat because the keys are already namespaced by their
// prefix ("nav.", "history."), and a nested tree would only add a lookup helper without
// making a single string easier to find.

export const LOCALES = ['en-US', 'de-DE'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-US';

/** What the language switcher offers, in each language's own name. */
export const LOCALE_NAMES: Record<Locale, string> = {
  'en-US': 'English (US)',
  'de-DE': 'Deutsch',
};

export type TranslationKey = keyof typeof enUS;
export type Dictionary = Record<string, string>;

const DICTIONARIES: Record<Locale, Dictionary> = {
  'en-US': enUS,
  'de-DE': deDE as Dictionary,
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Values substituted into a string are formatted by the caller, so this stays a plain swap. */
export type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * A translation function bound to one locale. Server components get it from
 * i18n/server.ts, client components from the provider in i18n/client.tsx — both end up
 * calling this, so a string reads the same on either side of the boundary.
 */
export type Translate = (key: TranslationKey, vars?: Vars) => string;

/**
 * Falls back to US English per key rather than per locale: a partly translated locale
 * should show the strings it does have, not drop back wholesale. The key itself is the
 * last resort, which makes a missing entry visible instead of blank.
 */
export function translate(locale: Locale, key: TranslationKey, vars?: Vars): string {
  const template = DICTIONARIES[locale]?.[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, vars);
}

export function translator(locale: Locale): Translate {
  return (key, vars) => translate(locale, key, vars);
}

/**
 * The dictionary handed to the client provider. Merged over US English so a client
 * component gets the same per-key fallback a server component gets, without shipping the
 * fallback logic twice.
 */
export function dictionaryFor(locale: Locale): Dictionary {
  return locale === DEFAULT_LOCALE
    ? DICTIONARIES[DEFAULT_LOCALE]
    : { ...DICTIONARIES[DEFAULT_LOCALE], ...DICTIONARIES[locale] };
}

export function t(key: TranslationKey, locale: Locale = DEFAULT_LOCALE, vars?: Vars): string {
  return translate(locale, key, vars);
}
