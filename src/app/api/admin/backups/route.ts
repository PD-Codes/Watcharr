import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import {
  cancelRestore,
  canRestart,
  createManualBackup,
  deleteBackup,
  stageRestore,
  verifyBackup,
} from '@/server/backups';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';
// quick_check on a large backup runs in a child process, but the request waits for it.
export const maxDuration = 600;

const ACTIONS = ['create', 'verify', 'restore', 'cancelRestore', 'delete', 'restart'] as const;

/** One endpoint for the Backups page; downloads stay on GET /api/admin/backup?name=. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  const body = await readBody(request, { action: 'string', name: 'string' });
  const action = ACTIONS.find((a) => a === body?.action);
  if (!body || !action) return badBody();
  const name = body.name ?? '';

  try {
    switch (action) {
      case 'create':
        return NextResponse.json({ ok: true, backup: await createManualBackup() });
      case 'verify':
        return NextResponse.json({ ok: true, result: await verifyBackup(name) });
      case 'restore': {
        const result = await stageRestore(name);
        return result.ok
          ? NextResponse.json({ ok: true, result, canRestart: canRestart() })
          : NextResponse.json({ error: result.error ?? 'The backup failed its integrity check', result }, { status: 422 });
      }
      case 'cancelRestore':
        await cancelRestore();
        return NextResponse.json({ ok: true });
      case 'delete':
        return (await deleteBackup(name))
          ? NextResponse.json({ ok: true })
          : NextResponse.json({ error: 'No such backup' }, { status: 404 });
      case 'restart':
        if (!canRestart()) return NextResponse.json({ error: 'Restart the app yourself' }, { status: 409 });
        // After the response is out: the compose restart policy brings the container back, and
        // the start script applies the staged restore before the server opens the database.
        setTimeout(() => process.exit(0), 500);
        return NextResponse.json({ ok: true });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
