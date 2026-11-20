// How strong SESSION_SECRET is. No 'server-only' and no I/O, so the tests, the system check,
// instrumentation and (later) an admin banner all ask the same question the same way.
//
// scripts/migrate.mjs carries a copy of these rules: the Docker image ships the scripts but
// not src/, so the startup gate cannot import this file. Change both together; the ops test
// runs the script against the same verdicts.

/** Why the secret is unsafe, or null when it is fine. */
export type SecretProblem = 'missing' | 'placeholder' | 'short';

/** `openssl rand -hex 32` gives 64 characters; half of that is the floor. */
export const MIN_SECRET_LENGTH = 32;

/** Values that ship in examples and therefore are public knowledge. */
const PLACEHOLDERS = new Set(['change-me', 'changeme']);

/**
 * The secret both signs the session cookies and derives the key that encrypts every stored
 * media server token, so a guessable one hands out both to anybody holding a copy of the
 * database (a backup, a support upload).
 */
export function secretProblem(value: string | undefined = process.env.SESSION_SECRET): SecretProblem | null {
  if (!value?.trim()) return 'missing';
  if (PLACEHOLDERS.has(value.trim().toLowerCase())) return 'placeholder';
  if (value.length < MIN_SECRET_LENGTH) return 'short';
  return null;
}

/**
 * For an admin banner: the translation key that explains the problem, or null when there is
 * none. Keys live in src/i18n/parts/data2.json.
 */
export function secretHintKey(
  value: string | undefined = process.env.SESSION_SECRET,
): `data2.secret.${SecretProblem}` | null {
  const problem = secretProblem(value);
  return problem ? `data2.secret.${problem}` : null;
}

/** The log line, shared by instrumentation and the startup script's wording. */
export function secretWarning(problem: SecretProblem): string {
  const what =
    problem === 'missing'
      ? 'SESSION_SECRET is not set'
      : problem === 'placeholder'
        ? 'SESSION_SECRET is still the placeholder from .env.example'
        : `SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  return (
    `${what}, so the stored media server tokens are only as safe as that value. ` +
    'Generate one with: openssl rand -hex 32. ' +
    'Changing it signs everyone out and the media server tokens have to be entered again.'
  );
}
