import { statfsSync } from 'node:fs';

// Where the database file lives decides how SQLite may lock it. No 'server-only': pure apart
// from one statfs call, so the test script imports it directly.

/**
 * statfs magic numbers of file systems whose locking SQLite cannot rely on: network shares,
 * and the FUSE/9p bridges Docker Desktop uses for bind mounts on Windows and macOS. On these
 * the WAL index (the -shm file is mmap'd shared memory) and the byte-range locks around every
 * transaction either fail or are slow enough to surface as "database is locked" while a
 * single process is the only one using the file.
 */
const REMOTE_FS: Record<number, string> = {
  0x6969: 'nfs',
  0x517b: 'smb',
  0xff534d42: 'cifs',
  0xfe534d42: 'smb2',
  0x65735546: 'fuse',
  0x01021997: '9p',
  0x00c36400: 'ceph',
  0x5346414f: 'afs',
};

export type LockingMode = 'normal' | 'exclusive';

/** The file system name when it is one of the risky ones, otherwise null (also on any error). */
export function remoteFileSystem(dir: string, statfs: (dir: string) => { type: number } = statfsSync): string | null {
  try {
    // f_type is unsigned on Linux but can arrive sign-extended; compare the low 32 bits.
    return REMOTE_FS[statfs(dir).type >>> 0] ?? null;
  } catch {
    return null;
  }
}

/**
 * EXCLUSIVE when asked for, or when the data folder is a share and nobody said otherwise.
 * In exclusive mode SQLite takes the file lock once and keeps it, and WAL keeps its index in
 * process memory instead of the -shm file — exactly what a share needs, at the price that no
 * second connection (the parallel readers) can open the file.
 */
export function chooseLocking(setting: string | undefined, remote: string | null): LockingMode {
  const wanted = setting?.trim().toLowerCase();
  if (wanted === 'exclusive' || wanted === 'normal') return wanted;
  return remote ? 'exclusive' : 'normal';
}
