import { NextResponse } from 'next/server';
import { supportsPinAuth } from '@/server/adapters';
import { getAdapter } from '@/server/config';

/** Starts the Plex PIN OAuth flow and returns the URL the user has to visit. */
export async function POST() {
  const adapter = await getAdapter();
  if (!supportsPinAuth(adapter)) {
    return NextResponse.json({ error: 'PIN auth is not supported' }, { status: 400 });
  }
  return NextResponse.json(await adapter.startPinAuth());
}
