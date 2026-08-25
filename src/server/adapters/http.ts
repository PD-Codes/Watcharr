/**
 * Every media server request goes through here, which is why the timeout lives here and
 * not at the call sites. Without it an unreachable server does not fail — the socket just
 * never settles, the catch() around the sync never runs, and because the sync sits in the
 * app layout, every single page hangs forever instead of rendering without live data.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Thin fetch wrapper: JSON in, JSON out, non-2xx throws with the response body. */
export async function apiFetch<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { Accept: 'application/json', ...rest.headers },
    cache: 'no-store',
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
