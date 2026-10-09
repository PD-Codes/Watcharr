import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Chunked, resumable upload for a Tautulli database. No 'server-only': plain fs code that
// takes its directory as an argument, so the tests can drive it without Next.
//
// A 1 GB file in one request is a bad idea twice over — the reverse proxy in front of the app
// has its own body limit, and Next buffers request bodies for its proxy layer (10 MB by
// default). So the browser slices the file into CHUNK_BYTES pieces and sends them one by one;
// the server only ever appends at the exact offset it already holds, which is what makes a
// dropped connection, a closed tab or a second attempt resumable instead of corrupting.

/** Stays well under the 10 MB body buffer Next applies to the proxy layer. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = Number(process.env.WATCHARR_IMPORT_MAX_GB ?? 50) * 1024 ** 3;
const STALE_MS = 7 * 86_400_000;
const ID = /^[a-f0-9]{32}$/;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set on a 409 so the client can continue from where the server really is. */
    readonly received?: number,
  ) {
    super(message);
  }
}

export interface UploadInfo {
  id: string;
  name: string;
  size: number;
  received: number;
  complete: boolean;
  createdAt: number;
}

const part = (dir: string, id: string) => join(dir, `${id}.part`);
const metaFile = (dir: string, id: string) => join(dir, `${id}.json`);

function checkId(id: string): string {
  if (!ID.test(id)) throw new UploadError('Unknown upload', 404);
  return id;
}

export async function uploadInfo(dir: string, id: string): Promise<UploadInfo> {
  checkId(id);
  let meta: { name: string; size: number; createdAt: number };
  try {
    meta = JSON.parse(await readFile(metaFile(dir, id), 'utf8'));
  } catch {
    throw new UploadError('Unknown upload', 404);
  }
  // The file on disk is the truth about progress; a counter in the meta file would drift the
  // first time a write died halfway.
  const received = await stat(part(dir, id)).then((s) => s.size, () => 0);
  return { id, ...meta, received, complete: received === meta.size };
}

export async function listUploads(dir: string): Promise<UploadInfo[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const infos = await Promise.all(
    names
      .filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5)))
      .map((name) => uploadInfo(dir, name.slice(0, -5)).catch(() => null)),
  );
  return infos.filter((i): i is UploadInfo => i !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteUpload(dir: string, id: string): Promise<void> {
  checkId(id);
  await Promise.all([rm(part(dir, id), { force: true }), rm(metaFile(dir, id), { force: true })]);
}

export async function startUpload(dir: string, name: string, size: number): Promise<UploadInfo> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError('The file is empty', 400);
  if (size > MAX_BYTES) {
    throw new UploadError(`The file is larger than the ${MAX_BYTES / 1024 ** 3} GB limit`, 413);
  }
  await mkdir(dir, { recursive: true });

  // Abandoned halves of old attempts would otherwise pile up in the data volume forever.
  for (const old of await listUploads(dir)) {
    if (Date.now() - old.createdAt > STALE_MS) await deleteUpload(dir, old.id);
  }

  // Better to refuse now than to fail at 90 % with a full disk (and a database that shares it).
  const fs = await statfs(dir).catch(() => null);
  if (fs && fs.bavail * fs.bsize < size * 1.1) {
    throw new UploadError('Not enough free disk space for this file', 507);
  }

  const id = randomBytes(16).toString('hex');
  // Display only: the file on disk is named after the id, never after this.
  const safeName = name.slice(0, 200) || 'tautulli.db';
  await writeFile(metaFile(dir, id), JSON.stringify({ name: safeName, size, createdAt: Date.now() }));
  await writeFile(part(dir, id), '');
  return uploadInfo(dir, id);
}

/** Appends one chunk, but only at the offset the server already holds. */
export async function appendChunk(
  dir: string,
  id: string,
  offset: number,
  data: Buffer,
): Promise<UploadInfo> {
  const info = await uploadInfo(dir, id);
  if (offset !== info.received) {
    throw new UploadError('Chunk offset does not match what the server holds', 409, info.received);
  }
  if (!data.length || info.received + data.length > info.size) {
    throw new UploadError('Chunk is empty or runs past the announced size', 400, info.received);
  }
  await appendFile(part(dir, id), data);

  const after = await uploadInfo(dir, id);
  if (after.complete) {
    // Refuse anything that is not a SQLite file right away, instead of after a long wait for
    // the preview to fail on it.
    const handle = await open(part(dir, id), 'r');
    try {
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      await handle.read(head, 0, head.length, 0);
      if (!head.equals(SQLITE_MAGIC)) {
        await deleteUpload(dir, id);
        throw new UploadError('That is not a SQLite database', 400);
      }
    } finally {
      await handle.close();
    }
  }
  return after;
}

/** Path of a finished upload; throws for an unknown or unfinished one. */
export async function completedPath(dir: string, id: string): Promise<{ path: string; name: string }> {
  const info = await uploadInfo(dir, id);
  if (!info.complete) throw new UploadError('The upload is not finished yet', 409, info.received);
  return { path: part(dir, id), name: info.name };
}
