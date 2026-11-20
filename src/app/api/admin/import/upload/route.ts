import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
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
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

async function guarded(run: () => Promise<Response>): Promise<Response> {
  const session = await getSession();
  if (!session?.user.globalAdmin) return globalAdminRequired();
  try {
    return await run();
  } catch (error) {
    if (error instanceof UploadError) {
      return apiError(error.status, 'upload-rejected', 'err.actionFailed', {
        message: error.message,
        extra: { received: error.received },
      });
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
      return apiError(413, 'chunk-too-large', 'err.chunkTooLarge');
    }
    const data = Buffer.from(await request.arrayBuffer());
    if (data.length > CHUNK_BYTES) return apiError(413, 'chunk-too-large', 'err.chunkTooLarge');
    return NextResponse.json({ upload: await appendChunk(IMPORT_DIR, params.get('id') ?? '', offset, data) });
  });
}

export function DELETE(request: Request) {
  return guarded(async () => {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const job = await getJob();
    // Pulling the file out from under a running import would fail it halfway.
    if (job?.status === 'running' && job.params.uploadId === id) {
      return apiError(409, 'upload-in-use', 'err.uploadInUse');
    }
    await deleteUpload(IMPORT_DIR, id);
    return NextResponse.json({ ok: true });
  });
}
