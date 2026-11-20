import { NextResponse } from 'next/server';
import { supportsQuickConnect, type AuthResult, type QuickConnectState } from '@/server/adapters';
import { readBody } from '@/server/body';
import { getAdapter, getServer } from '@/server/config';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { boundQuickConnect, clearQuickConnect, createSession, recordLogin } from '@/server/session';
import { checkSetupToken } from '@/server/setuptoken';
import { dropPending, getPending, takePending } from '@/server/quickconnect';
import { apiError, badBody } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * Polled by the login page until the code was approved in a signed-in Jellyfin client. Then the
 * sign-in ends exactly like a password login: same session, same login history, same setup
 * token claim.
 */
export async function POST(request: Request) {
  const body = await readBody(request, { setupToken: 'string' });
  if (!body) return badBody();

  // Only the browser that started the request may collect its sign-in (see bindQuickConnect).
  const handle = await boundQuickConnect();
  if (!handle) {
    return apiError(400, 'unbound', 'err.otherBrowser');
  }
  const entry = getPending(handle);
  if (!entry) {
    await clearQuickConnect();
    return apiError(410, 'expired', 'err.codeExpired');
  }
  const server = await getServer(entry.serverId);
  if (!server) {
    dropPending(handle);
    await clearQuickConnect();
    return apiError(400, 'unknown-server', 'err.unknownServer');
  }

  const ip = clientIp(request);
  if (!rateLimit(`quickconnect:${server.id}:${ip}`, 120, 60_000)) {
    return apiError(429, 'limited', 'err.limited');
  }

  // Before the state is read: a wrong token ends the flow instead of spending an approval.
  const setup = await checkSetupToken(body.setupToken, ip);
  if (setup === 'invalid' || setup === 'limited') {
    return apiError(
      setup === 'limited' ? 429 : 401,
      'setup-token',
      setup === 'limited' ? 'err.limited' : 'err.setupTokenInvalid',
    );
  }

  const adapter = await getAdapter(server.id);
  if (!supportsQuickConnect(adapter)) {
    return apiError(400, 'unsupported', 'err.quickConnectUnsupported');
  }

  let state: QuickConnectState;
  try {
    state = await adapter.quickConnectState(entry.request);
  } catch (error) {
    // Slow or briefly unreachable: the request stays valid and the page asks again next tick.
    console.warn(`[watcharr] Quick Connect: ${(error as Error | null)?.message ?? error}; the login page retries`);
    return apiError(504, 'timeout', 'err.serverTimeout');
  }
  if (state === 'pending') return NextResponse.json({ pending: true, expiresAt: entry.expiresAt });
  if (state === 'expired') {
    dropPending(handle);
    await clearQuickConnect();
    return apiError(410, 'expired', 'err.codeExpired');
  }

  // Authorized. Taken out of the list before the await: a second poll in flight finds nothing
  // to redeem and simply asks again, instead of creating a second session.
  const claimed = takePending(handle);
  if (!claimed) return NextResponse.json({ pending: true, expiresAt: entry.expiresAt });
  await clearQuickConnect();

  const meta = { ip, userAgent: request.headers.get('user-agent') ?? undefined };
  let result: AuthResult;
  try {
    result = await adapter.authenticateQuickConnect(claimed.request);
  } catch {
    // Approved but not redeemable (revoked in between, or the server restarted): a failed sign-in.
    void recordLogin(server.id, 'Quick Connect', false, meta);
    return apiError(410, 'failed', 'err.signInIncomplete');
  }
  await createSession(server.id, result.user, result.token, meta, { claimAdmin: setup === 'valid' });
  return NextResponse.json({ ok: true, isAdmin: result.user.isAdmin });
}
