import 'server-only';
import { cache } from 'react';
import { getSettings } from '@/server/config';
import {
  DEFAULT_LOCALE,
  isLocale,
  translator,
  type Locale,
  type Translate,
} from './index';

/**
 * The locale for the current request: the signed-in user's own choice, otherwise the
 * deployment default an admin set. There is no cookie and no Accept-Language sniffing —
 * the choice lives in the database so the same account reads the same language on every
 * device, which is exactly what a per-browser cookie could not do.
 *
 * cache() scopes the memo to one request, so a page with twenty translated sections still
 * resolves the locale once.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  // Imported here rather than at the top of the file: session.ts pulls in next/headers,
  // which only exists inside a request. getDefaultLocale() below runs from the background
  // sync, and a module-level import would drag that dependency along for no reason.
  const { getSession } = await import('@/server/session');
  const session = await getSession().catch(() => null);
  if (session && isLocale(session.user.locale)) return session.user.locale;
  return getDefaultLocale();
});

/**
 * The language an admin picked for the deployment. This is what anything running outside
 * a request answers in — notifications, the monitor, the newsletter — because there is no
 * session there to read a personal preference from.
 */
export async function getDefaultLocale(): Promise<Locale> {
  const settings = await getSettings().catch(() => null);
  return isLocale(settings?.defaultLocale) ? settings.defaultLocale : DEFAULT_LOCALE;
}

/** Translation function for a server component. */
export async function getT(): Promise<Translate> {
  return translator(await getLocale());
}

/** Translation function for background work. See getDefaultLocale(). */
export async function getDefaultT(): Promise<Translate> {
  return translator(await getDefaultLocale());
}
