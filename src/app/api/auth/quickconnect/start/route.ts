import { NextResponse } from 'next/server';
import { supportsQuickConnect, type QuickConnectRequest } from '@/server/adapters';
import { readBody } from '@/server/body';
import { getAdapter, getServer, listServers } from '@/server/config';
import { clientIp } from '@/server/ratelimit';
import { bindQuickConnect, boundQuickConnect } from '@/server/session';
import {
  allowQuickConnectStart,
  dropPending,
  jellyfinQuickConnectUrl,
  putPending,
  QUICK_CONNECT_TTL_MS,
} from '@/server/quickconnect';
import { apiError, badBody } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * Starts a Jellyfin Quick Connect sign-in. Errors carry `reason`, not `code`: `code` is the
 * Quick Connect code itself here.
 * Answers the code to show and when it runs out; the request behind it stays in server memory,
 * bound to this browser by a signed cookie.
 */
export async function POST(request: Request) {
  const body = await readBody(request, { serverId: 'number' });
  if (!body) return badBody({ codeField: 'reason' });
  const server = body.serverId ? await getServer(body.serverId) : (await listServers())[0];
  if (!server) return apiError(400, 'unknown-server', 'err.unknownServer', { codeField: 'reason' });

  // Each start costs the media server a request and this process a slot in the pending list.
  if (!allowQuickConnectStart(server.id, clientIp(request))) {
    return apiError(429, 'limited', 'err.limited', { codeField: 'reason' });
  }

  const adapter = await getAdapter(server.id);
  if (!supportsQuickConnect(adapter)) {
    return apiError(400, 'unsupported', 'err.quickConnectUnsupported', { codeField: 'reason' });
  }

  let started: QuickConnectRequest | null;
  try {
    started = await adapter.initiateQuickConnect();
  } catch {
    return apiError(502, 'unreachable', 'err.serverNoAnswer', { codeField: 'reason' });
  }
  if (!started) {
    return apiError(409, 'disabled', 'err.quickConnectDisabled', { codeField: 'reason' });
  }

  // A second start in the same browser replaces the first: only one code can be on screen.
  const previous = await boundQuickConnect();
  if (previous) dropPending(previous);
  const entry = putPending(server.id, started);
  await bindQuickConnect(entry.handle, Math.ceil(QUICK_CONNECT_TTL_MS / 1000));

  return NextResponse.json({
    code: started.code,
    expiresAt: entry.expiresAt,
    webUrl: jellyfinQuickConnectUrl(server.serverUrl),
  });
}
