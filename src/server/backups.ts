import 'server-only';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { backupTo, DB_PATH } from '@/db';
import { BACKUP_DIR } from './autobackup';

const run = promisify(execFile);

// Backups you can manage: the scheduled ones from autobackup.ts, ones taken by hand, and the
// safety copy a restore leaves behind. Only `watcharr-*` is ever pruned by the retention
// count — a manual backup is somebody's deliberate "keep this" and must outlive it.

const MARKER = join(dirname(DB_PATH), 'restore-pending.json');
const NAME = /^[A-Za-z0-9][\w.-]*\.db$/;

export type BackupKind = 'scheduled' | 'manual' | 'pre-restore' | 'pre-import' | 'other';

export interface BackupEntry {
  name: string;
  kind: BackupKind;
  size: number;
  createdAt: Date;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  quickCheck?: string;
  watcharr?: boolean;
  users?: number | null;
  history?: number | null;
  sessions?: number | null;
  migrations?: number | null;
}

function kindOf(name: string): BackupKind {
  if (name.startsWith('watcharr-')) return 'scheduled';
  if (name.startsWith('manual-')) return 'manual';
  if (name.startsWith('pre-restore-')) return 'pre-restore';
  if (name.startsWith('pre-import-')) return 'pre-import';
  return 'other';
}

export async function listBackups(): Promise<BackupEntry[]> {
  const names = (await readdir(BACKUP_DIR).catch(() => [] as string[])).filter((n) => NAME.test(n));
  const entries = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(BACKUP_DIR, name));
      return { name, kind: kindOf(name), size: info.size, createdAt: info.mtime };
    }),
  );
  return entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The path of a backup that exists, or null. The name comes from the browser. */
export async function backupPath(name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  const path = join(BACKUP_DIR, name);
  return (await stat(path).then((s) => s.isFile(), () => false)) ? path : null;
}

export async function createManualBackup(prefix: 'manual' | 'pre-import' = 'manual'): Promise<BackupEntry> {
  await mkdir(BACKUP_DIR, { recursive: true });
  // A snapshot is about as big as the database; better to refuse than to fill the volume
  // the live database itself needs to grow in.
  const [{ size }, fs] = await Promise.all([stat(DB_PATH), statfs(BACKUP_DIR).catch(() => null)]);
  if (fs && fs.bavail * fs.bsize < size * 1.2) throw new Error('Not enough free disk space for a backup');

  const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  await backupTo(join(BACKUP_DIR, name));
  const info = await stat(join(BACKUP_DIR, name));
  return { name, kind: kindOf(name), size: info.size, createdAt: info.mtime };
}

export async function deleteBackup(name: string): Promise<boolean> {
  const path = await backupPath(name);
  if (!path) return false;
  await rm(path);
  return true;
}

/** Integrity check in a child process — see scripts/verify-backup.mjs for why. */
export async function verifyBackup(name: string): Promise<VerifyResult> {
  const path = await backupPath(name);
  if (!path) return { ok: false, error: 'No such backup' };
  try {
    const { stdout } = await run(process.execPath, [join(process.cwd(), 'scripts', 'verify-backup.mjs'), path], {
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 64,
    });
    return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as VerifyResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Verification failed' };
  }
}

export async function pendingRestore(): Promise<string | null> {
  try {
    const { file } = JSON.parse(await readFile(MARKER, 'utf8')) as { file?: string };
    return typeof file === 'string' ? file : null;
  } catch {
    return null;
  }
}

/**
 * Stages a restore for the next start. Verified first, so a corrupt file is refused here, in
 * front of the admin, instead of being skipped silently by the startup script. The swap
 * itself is in scripts/migrate.mjs — see there for why it cannot happen in this process.
 */
export async function stageRestore(name: string): Promise<VerifyResult> {
  const result = await verifyBackup(name);
  if (!result.ok) return result;
  await writeFile(MARKER, JSON.stringify({ file: name, stagedAt: Date.now() }));
  return result;
}

export async function cancelRestore(): Promise<void> {
  await rm(MARKER, { force: true });
}

/** Whether exiting the process brings it back: the compose file restarts the container. */
export const canRestart = () => existsSync('/.dockerenv') || process.env.WATCHARR_ALLOW_RESTART === '1';
