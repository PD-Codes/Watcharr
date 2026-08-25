import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { backupTo } from '@/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Downloads a consistent snapshot of the SQLite file. No restore endpoint — see the note
 * on backupTo() in src/db/index.ts for why that has to be an operational step instead.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const dir = await mkdtemp(join(tmpdir(), 'watcharr-backup-'));
  const file = join(dir, 'watcharr.db');
  try {
    await backupTo(file);
    const data = await readFile(file);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="watcharr-${stamp}.db"`,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
