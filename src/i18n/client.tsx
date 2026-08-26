'use client';

import { createContext, useContext, useMemo } from 'react';
import {
  DEFAULT_LOCALE,
  type Dictionary,
  type Locale,
  type Translate,
  type TranslationKey,
  type Vars,
} from './index';

// Client components cannot await getLocale(), so the resolved dictionary is handed down
// once from the root layout. That also keeps a translated label from flashing in English
// before hydration, which a fetch-on-mount approach could not.
//
// ponytail: the whole dictionary is serialised into every page payload, including the
// keys only server components use — roughly 20 KB raw, a few KB over the wire. Splitting
// out just the client-used keys would need a build step that scans for useT() call sites;
// worth it only once the payload actually shows up in a measurement.

interface LocaleValue {
  locale: Locale;
  dictionary: Dictionary;
}

const LocaleContext = createContext<LocaleValue>({ locale: DEFAULT_LOCALE, dictionary: {} });

export function LocaleProvider({
  locale,
  dictionary,
  children,
}: LocaleValue & { children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, dictionary }), [locale, dictionary]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Same signature as the server-side translate, so a string moves between them unchanged. */
export function useT(): Translate {
  const { dictionary } = useContext(LocaleContext);
  return useMemo(
    () => (key: TranslationKey, vars?: Vars) => {
      const template = dictionary[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    },
    [dictionary],
  );
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}
