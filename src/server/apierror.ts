import 'server-only';
import { unstable_rethrow } from 'next/navigation';
import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, translator, type Translate, type TranslationKey, type Vars } from '@/i18n';
import { getT } from '@/i18n/server';

/*
 * Error answers of the JSON API in the reader's language.
 *
 * Every error carries two things: `error`, the sentence a client shows as it is, and `code`, a
 * stable token a client branches on. Clients already display `body.error` directly, so the text
 * has to be in the language the person reads the rest of the app in — the same session → database
 * → default chain the pages use (getT). The code never changes with the language, which is why a
 * client must never compare against the text.
 */

/** The request's translator; the deployment default when the session or the database fails. */
export async function requestT(): Promise<Translate> {
  // An error answer must not itself turn into a 500 because the locale lookup failed (database
  // locked, cookies() outside a request): English is still a better answer than none.
  return getT().catch(() => translator(DEFAULT_LOCALE));
}

export interface ApiErrorOptions {
  vars?: Vars;
  /**
   * A message a server module already produced (a mail relay's refusal, a failed check) shown
   * instead of the key's text; the key is then only the fallback for when there is none.
   */
  message?: string | null;
  /** Further fields for the body, e.g. the stored result next to a failed restore. */
  extra?: Record<string, unknown>;
  headers?: HeadersInit;
  /**
   * The field the machine code goes into. Quick Connect's start route answers with the Quick
   * Connect code in `code`, so its errors have always named the reason `reason` instead.
   */
  codeField?: 'code' | 'reason';
}

/** `{ error, code }` with the given status, the text translated for the requesting user. */
export async function apiError(
  status: number,
  code: string,
  key: TranslationKey,
  { vars, message, extra, headers, codeField = 'code' }: ApiErrorOptions = {},
): Promise<NextResponse> {
  const error = message || (await requestT())(key, vars);
  return NextResponse.json({ ...extra, error, [codeField]: code }, { status, headers });
}

// The answers nearly every route gives, so the wording and the code stay the same everywhere.
export const unauthorized = (options?: ApiErrorOptions) => apiError(401, 'unauthorized', 'err.unauthorized', options);
export const adminRequired = (options?: ApiErrorOptions) => apiError(403, 'admin-required', 'err.adminRequired', options);
export const globalAdminRequired = (options?: ApiErrorOptions) =>
  apiError(403, 'global-admin-required', 'err.globalAdminRequired', options);
export const badBody = (options?: ApiErrorOptions) => apiError(400, 'bad-body', 'err.badBody', options);

/**
 * Wraps a route handler so an exception nobody caught still ends as a JSON answer: logged here
 * with the route, answered as a translated 500 with `code: 'unexpected'`. The message stays in the
 * log — an error from a media server or a mail relay can name hosts, paths or SQL, none of which
 * belongs in front of whoever sent the request.
 */
export function withApiErrors<A extends unknown[]>(
  handler: (...args: A) => Promise<Response> | Response,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      // redirect(), notFound() and Next's dynamic-rendering bailouts travel as exceptions too;
      // they are control flow, not failures.
      unstable_rethrow(error);
      const request = args[0] instanceof Request ? args[0] : null;
      const where = request ? `${request.method} ${new URL(request.url).pathname}` : 'API route';
      console.error(`[watcharr] ${where} failed:`, error);
      return apiError(500, 'unexpected', 'err.unexpected');
    }
  };
}
