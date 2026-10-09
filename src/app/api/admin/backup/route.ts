import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await backupTo(file);
    const { size } = await stat(file);
    // Streamed, not read into memory: a database with years of history is hundreds of MB.
    const stream = createReadStream(file);
    // The snapshot goes when the download ends, whether it finished or the client left.
    stream.once('close', () => void cleanup());
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="watcharr-${stamp}.db"`,
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
