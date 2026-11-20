import { NextResponse } from 'next/server';
import { boundQuickConnect, clearQuickConnect } from '@/server/session';
import { dropPending } from '@/server/quickconnect';

export const dynamic = 'force-dynamic';

/** Cancels this browser's pending Quick Connect sign-in. The code then cannot sign anybody in. */
export async function DELETE() {
  const handle = await boundQuickConnect();
  if (handle) dropPending(handle);
  await clearQuickConnect();
  return NextResponse.json({ ok: true });
}
