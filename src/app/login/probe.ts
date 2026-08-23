/**
 * Confirms that the browser actually kept the session cookie.
 *
 * The server cannot know this: it sets the cookie on the response and hears nothing back
 * if the browser discards it. Without this check the failure is invisible — sign-in answers
 * 200, the redirect fires, the next page finds no session and returns to the login screen,
 * and nothing anywhere says why. That silence is worse than any error message.
 *
 * `/api/search` is the probe because it already answers 401 without a session and needs no
 * new route to exist for this.
 */
export async function sessionCookieRejected(): Promise<boolean> {
  try {
    const res = await fetch('/api/search?q=__probe', { cache: 'no-store' });
    return res.status === 401;
  } catch {
    // Offline or blocked: let the redirect happen and fail in the ordinary way.
    return false;
  }
}

export const COOKIE_REJECTED_MESSAGE =
  'Signed in, but your browser did not keep the session cookie. This usually means the app ' +
  'is reached over plain HTTP while APP_URL or the reverse proxy claims HTTPS. Check that ' +
  'APP_URL matches the address in your address bar.';
