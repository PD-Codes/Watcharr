import { NextResponse } from 'next/server';
import { badBody, readBody } from '@/server/body';
import { IMPORT_DIR, getJob } from '@/server/importjob';
import {
  CHUNK_BYTES,
  UploadError,
  appendChunk,
  deleteUpload,
  listUploads,
  startUpload,
  uploadInfo,
} from '@/server/importupload';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

async function guarded(run: () => Promise<Response>): Promise<Response> {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message, received: error.received }, { status: error.status });
    }
    throw error;
  }
}

/** Without `id`: every upload on disk. With it: how far that one got — the resume question. */
export function GET(request: Request) {
  return guarded(async () => {
    const id = new URL(request.url).searchParams.get('id');
    return NextResponse.json(
      id ? { upload: await uploadInfo(IMPORT_DIR, id) } : { uploads: await listUploads(IMPORT_DIR) },
    );
  });
}

/** Announces a file and gets its id back. */
export function POST(request: Request) {
  return guarded(async () => {
    const body = await readBody(request, { name: 'string', size: 'number' });
    if (!body || body.size == null) return badBody();
    const upload = await startUpload(IMPORT_DIR, body.name ?? 'tautulli.db', body.size);
    return NextResponse.json({ upload, chunkBytes: CHUNK_BYTES }, { status: 201 });
  });
}

/** One chunk of raw bytes, appended at `offset` — or refused with where the server really is. */
export function PUT(request: Request) {
  return guarded(async () => {
    const params = new URL(request.url).searchParams;
    const offset = Number(params.get('offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) return badBody();
    // Checked before reading: the point of the limit is not to buffer an oversized body.
    if (Number(request.headers.get('content-length') ?? 0) > CHUNK_BYTES) {
      throw new UploadError('Chunk is larger than the agreed size', 413);
    }
    const data = Buffer.from(await request.arrayBuffer());
    if (data.length > CHUNK_BYTES) {
      throw new UploadError('Chunk is larger than the agreed size', 413);
    }
    return NextResponse.json({ upload: await appendChunk(IMPORT_DIR, params.get('id') ?? '', offset, data) });
  });
}

export function DELETE(request: Request) {
  return guarded(async () => {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const job = await getJob();
    // Pulling the file out from under a running import would fail it halfway.
    if (job?.status === 'running' && job.params.uploadId === id) {
      throw new UploadError('This file is being imported right now', 409);
    }
    await deleteUpload(IMPORT_DIR, id);
    return NextResponse.json({ ok: true });
  });
}
