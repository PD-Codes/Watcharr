import { NextResponse } from 'next/server';
import { getAdapter } from '@/server/config';
import { supportsTerminate } from '@/server/adapters';
import { getSession } from '@/server/session';
import { sessionRowKey } from '@/server/sync';
import { adminRequired, apiError, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

const MAX_REASON_LENGTH = 200;

/**
 * Stops a running stream. The native handle is read from the live session list rather than
 * from the stored row: on Plex the two are different values, and a stream that is no longer
 * live cannot be terminated anyway.
 */
export const POST = withApiErrors(async (request: Request) => {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) return adminRequired();

  const body: unknown = await request.json().catch(() => null);
  const sessionKey = (body as { sessionKey?: unknown } | null)?.sessionKey;
  const rawReason = (body as { reason?: unknown } | null)?.reason;
  if (typeof sessionKey !== 'string' || !sessionKey) {
    return apiError(400, 'missing-session-key', 'err.sessionKeyRequired');
  }
  const reason =
    typeof rawReason === 'string' && rawReason.trim()
      ? rawReason.trim().slice(0, MAX_REASON_LENGTH)
      : undefined;

  // The stored key names the server it came from, which is the one to talk to — a global
  // admin may be looking at a stream on a server they did not sign in through.
  const serverId = Number(sessionKey.split(':')[0]);
  if (!Number.isInteger(serverId) || serverId < 1) {
    return apiError(400, 'unknown-session', 'err.unknownSession');
  }
  if (!session.user.globalAdmin && serverId !== session.user.serverId) {
    return apiError(403, 'not-your-server', 'err.notYourServer');
  }

  const adapter = await getAdapter(serverId).catch(() => null);
  if (!adapter) return apiError(404, 'unknown-server', 'err.unknownServer');
  if (!supportsTerminate(adapter)) {
    return apiError(501, 'unsupported', 'err.terminateUnsupported', { vars: { type: adapter.type } });
  }

  // Stored keys carry the server prefix; the adapter reports the native one.
  const live = await adapter.getSessions();
  const target = live.find(
    (s) => sessionRowKey(serverId, s.sessionKey) === sessionKey,
  );
  if (!target?.terminateKey) {
    return apiError(404, 'stream-gone', 'err.streamGone');
  }

  try {
    await adapter.terminateSession(target.terminateKey, reason);
  } catch {
    return apiError(502, 'terminate-refused', 'err.terminateRefused');
  }
  return NextResponse.json({ ok: true });
});
