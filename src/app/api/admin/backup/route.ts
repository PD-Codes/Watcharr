import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { backupTo, InsufficientSpaceError } from '@/db';
import { backupPath } from '@/server/backups';
import { getSession } from '@/server/session';
import { apiError, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * Downloads a consistent snapshot of the SQLite file, or a stored backup with ?name=. Restoring
 * is staged from /admin/backups and applied at the next start — see the note on backupTo()
 * in src/db/index.ts for why the swap cannot happen in a request.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();

  // ?name= serves a stored backup as it is; without it, a fresh snapshot is taken.
  const name = new URL(request.url).searchParams.get('name');
  if (name) {
    const path = await backupPath(name);
    if (!path) return apiError(404, 'backup-not-found', 'err.backupNotFound');
    return new NextResponse(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': String((await stat(path)).size),
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
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
    // backupTo checks the temp folder first: a snapshot that fills /tmp (often the same volume
    // as the data) would take the live database down with it. Said plainly, not as a 500.
    if (error instanceof InsufficientSpaceError) {
      return apiError(507, 'insufficient-space', 'err.actionFailed', { message: error.message });
    }
    throw error;
  }
}
