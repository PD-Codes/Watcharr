import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { DB_PATH, db } from '@/db';
import { createManualBackup } from './backups';
import { getServer } from './config';
import { completedPath } from './importupload';
import { importFromTautulli, type ImportSummary } from './tautulli';
import { globalState } from './state';

// The Tautulli import as a background job. A route that held the request open until a
// multi-million-row import finished would be killed by the first proxy timeout, and the
// admin would be left guessing what got written. Instead the route starts the job and
// returns; the page polls for progress.
//
// One job at a time, kept in process-wide state (see state.ts) and mirrored to
// data/imports/job.json after every few batches. If the container restarts mid-import the
// file survives, the page shows "interrupted at 43 %" and one click continues from the
// cursor — safe because both writers skip what they already wrote.
//
// ponytail: single process, single job. Two app instances would each believe they are the
// only runner; the documented deployment is one container.

export const IMPORT_DIR = join(dirname(DB_PATH), 'imports');
const JOB_FILE = join(IMPORT_DIR, 'job.json');
const PERSIST_EVERY_MS = 750;

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface JobParams {
  /** An absolute path on the host, or the id of a finished upload. Exactly one. */
  path?: string;
  uploadId?: string;
  serverId: number;
  dryRun: boolean;
  days?: number;
  userMap?: Record<string, number | null>;
  /** Create accounts for Tautulli users nobody matches (default on) and import their logins. */
  createUsers?: boolean;
  logins?: boolean;
  /** Snapshot the database before a real import (default on). Resumed runs skip it. */
  backup?: boolean;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: JobParams;
  /** What the file is called, for display — never a path the browser could reuse. */
  label: string;
  startedAt: number;
  finishedAt?: number;
  summary: ImportSummary | null;
  error?: string;
}

const state = globalState('importJob', () => ({
  job: null as Job | null,
  stop: false,
  lastPersist: 0,
  // Writes to job.json run one after another, in call order (see persist()).
  tail: Promise.resolve() as Promise<unknown>,
}));

async function persist(job: Job, force = false) {
  if (!force && Date.now() - state.lastPersist < PERSIST_EVERY_MS) return;
  state.lastPersist = Date.now();
  // Snapshot now, write later: the file ends up holding the state of the last call, and the
  // writes never overlap. Two writers sharing one temp file made a finished job's final write
  // collide with the next job's first (ENOENT on rename), found by the large-import stress run.
  const snapshot = JSON.stringify(job);
  const write = state.tail.then(async () => {
    await mkdir(IMPORT_DIR, { recursive: true });
    // Write-then-rename: a crash mid-write must not leave half a JSON file as the only record.
    await writeFile(`${JOB_FILE}.tmp`, snapshot);
    await rename(`${JOB_FILE}.tmp`, JOB_FILE);
  });
  state.tail = write.catch(() => {});
  await write;
}

/** The live job, or the last one on disk. A "running" file with no live job was cut off. */
export async function getJob(): Promise<Job | null> {
  if (state.job) return state.job;
  try {
    const stored = JSON.parse(await readFile(JOB_FILE, 'utf8')) as Job;
    return stored.status === 'running' ? { ...stored, status: 'interrupted' } : stored;
  } catch {
    return null;
  }
}

async function resolveSource(params: JobParams): Promise<{ path: string; label: string }> {
  if (params.uploadId) {
    const { path, name } = await completedPath(IMPORT_DIR, params.uploadId);
    return { path, label: name };
  }
  if (params.path) return { path: params.path, label: params.path.split(/[\\/]/).pop() ?? params.path };
  throw new Error('A database path or an uploaded file is required');
}

/** Starts a job, or continues an interrupted one when `resumeFrom` is given. */
export async function startJob(params: JobParams, resumeFrom?: Job): Promise<Job> {
  if (state.job?.status === 'running') throw new Error('An import is already running');
  if (!(await getServer(params.serverId))) throw new Error('Unknown server');
  const source = await resolveSource(params);

  const job: Job = {
    id: resumeFrom?.id ?? `${Date.now()}`,
    status: 'running',
    params,
    label: source.label,
    startedAt: resumeFrom?.startedAt ?? Date.now(),
    summary: resumeFrom?.summary ?? null,
  };
  state.job = job;
  state.stop = false;
  await persist(job, true);

  void (async () => {
    try {
      // The way back from an import is a backup (there is deliberately no undo button), so the
      // job takes one itself instead of trusting the admin to remember.
      if (!params.dryRun && params.backup !== false && !resumeFrom) await createManualBackup('pre-import');
      const prior = resumeFrom?.summary;
      const summary = await importFromTautulli(source.path, params.serverId, {
        dryRun: params.dryRun,
        sinceMs: params.days ? Date.now() - params.days * 86_400_000 : 0,
        userMap: params.userMap,
        createUsers: params.createUsers !== false,
        logins: params.logins !== false,
        resume: prior ? {
          lastId: prior.lastId,
          scanned: prior.scanned,
          candidates: prior.candidates,
          plays: prior.plays,
          streams: prior.streams,
          createdUsers: prior.createdUsers,
          logins: prior.logins,
          unmatched: Object.fromEntries(prior.unmatched.map((u) => [u.name, u.rows])),
        } : undefined,
        shouldStop: () => state.stop,
        onProgress: async (progress) => {
          job.summary = { ...progress };
          await persist(job);
        },
      });
      job.summary = summary;
      job.status = summary.stopped ? 'stopped' : 'done';
      // An import can double a table; refresh the planner's statistics while it is fresh news.
      if (!params.dryRun) db.run(sql`ANALYZE`);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Import failed';
    } finally {
      job.finishedAt = Date.now();
      state.stop = false;
      await persist(job, true).catch(() => {});
    }
  })();
  return job;
}

/** Asks the running job to finish its current batch and stop. */
export function stopJob(): boolean {
  if (state.job?.status !== 'running') return false;
  state.stop = true;
  return true;
}
