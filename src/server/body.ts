// Pure (no server-only import) so the unit test can run it without Next.

interface Values {
  string: string;
  number: number;
  boolean: boolean;
  strings: string[];
  /** Plain object with string values, e.g. a channel's config. */
  stringMap: Record<string, string>;
  /** Plain object with boolean values, e.g. feature flags. */
  flags: Record<string, boolean>;
  object: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CHECKS: Record<keyof Values, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  // Finite: JSON has no Infinity, but `1e999` parses to one.
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  strings: (v) => Array.isArray(v) && v.every((e) => typeof e === 'string'),
  stringMap: (v) => isObject(v) && Object.values(v).every((e) => typeof e === 'string'),
  flags: (v) => isObject(v) && Object.values(v).every((e) => typeof e === 'boolean'),
  object: isObject,
};

/**
 * The JSON body of a request, or null when it is malformed, not an object, or a field
 * listed in `shape` holds the wrong type. A field that is missing or null always passes —
 * callers already treat those as "not given" or "clear it". Without this, a body like
 * `{"name": ["x"]}` throws deep inside a handler and the client gets a 500 instead of a 400.
 */
export async function readBody<S extends Record<string, keyof Values>>(
  request: Request,
  shape: S,
): Promise<{ [K in keyof S]?: Values[S[K]] | null } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!isObject(body)) return null;
  for (const [key, kind] of Object.entries(shape)) {
    const value = body[key];
    if (value != null && !CHECKS[kind](value)) return null;
  }
  return body as { [K in keyof S]?: Values[S[K]] | null };
}

export const badBody = () => Response.json({ error: 'Invalid request body' }, { status: 400 });
