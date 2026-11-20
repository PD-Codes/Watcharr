import { NextResponse } from 'next/server';
import { readBody } from '@/server/body';
import { getJob, startJob, stopJob, type JobParams } from '@/server/importjob';
import { UploadError } from '@/server/importupload';
import { getGlobalAdminSession } from '@/server/session';
import { apiError, badBody, globalAdminRequired } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Progress of the current (or last) import — what the page polls. */
export async function GET() {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  return NextResponse.json({ job: await getJob() });
}

/**
 * Starts an import as a background job and returns at once.
 *
 * Global admin only, and a `path` is read from the container's own filesystem — this is the
 * one endpoint that opens a file the caller names, so it is fenced by the strongest role in
 * the app rather than by validation of the path itself. A server admin can already see
 * everything on their server; being able to name a file on the host is a different kind of
 * power and belongs with whoever runs the deployment. An uploaded file is addressed by the
 * id the upload handed out, never by a path.
 */
export async function POST(request: Request) {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();

  const body = await readBody(request, {
    path: 'string',
    uploadId: 'string',
    serverId: 'number',
    dryRun: 'boolean',
    days: 'number',
    userMap: 'object',
    resume: 'boolean',
    backup: 'boolean',
    createUsers: 'boolean',
    logins: 'boolean',
  });
  if (!body) return badBody();

  const userMap: Record<string, number | null> = {};
  for (const [name, id] of Object.entries(body.userMap ?? {})) {
    if (id !== null && !Number.isInteger(id)) return badBody();
    userMap[name] = id as number | null;
  }
  const days = Number(body.days);
  const params: JobParams = {
    path: body.path?.trim() || undefined,
    uploadId: body.uploadId || undefined,
    serverId: Number(body.serverId),
    dryRun: body.dryRun === true,
    days: Number.isFinite(days) && days > 0 ? days : undefined,
    userMap,
    backup: body.backup !== false,
    createUsers: body.createUsers !== false,
    logins: body.logins !== false,
  };
  if (!params.path === !params.uploadId) {
    return apiError(400, 'import-source', 'err.importSource');
  }

  try {
    const previous = body.resume ? await getJob() : null;
    if (body.resume && (!previous || previous.status === 'running' || previous.status === 'done')) {
      return apiError(409, 'nothing-to-resume', 'err.nothingToResume');
    }
    // A resumed run keeps the parameters it started with; the request only says "go on".
    const job = previous
      ? await startJob(previous.params, previous)
      : await startJob(params);
    return NextResponse.json({ ok: true, job }, { status: 202 });
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 400;
    return apiError(status, 'import-failed', 'err.importFailed', {
      message: error instanceof Error ? error.message : null,
    });
  }
}

/** Stops the running import after its current batch. What was written stays written. */
export async function DELETE() {
  if (!(await getGlobalAdminSession())) return globalAdminRequired();
  return NextResponse.json({ ok: stopJob() });
}
