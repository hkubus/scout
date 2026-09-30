import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const backupArgument = argument('--backup');
const databaseArgument = argument('--database') ?? process.env.SCOUT_DB_PATH ?? './data/scout.sqlite';
if (!backupArgument || !process.argv.includes('--confirm')) {
  throw new Error('Usage: npm run db:restore -- --backup ./data/scout.sqlite.2026.backup.sqlite --confirm [--database ./data/scout.sqlite]');
}

const backupPath = resolve(backupArgument);
const databasePath = resolve(databaseArgument);
if (!existsSync(backupPath)) throw new Error(`Backup does not exist: ${backupPath}`);
if (backupPath === databasePath) throw new Error('Backup and database paths must be different');

// Validate the standalone VACUUM INTO file before touching the live path.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
const backupDb = new DatabaseSync(backupPath);
try {
  backupDb.exec('PRAGMA query_only = ON');
  const integrity = backupDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
  if (integrity.integrity_check !== 'ok') throw new Error(`Backup integrity check failed: ${integrity.integrity_check ?? 'unknown result'}`);
  for (const table of ['migrations', 'settings', 'watches']) {
    if (!backupDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`Backup is missing the ${table} table`);
  }
} finally {
  backupDb.close();
}

const directory = dirname(databasePath);
mkdirSync(directory, { recursive: true });
const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
const stagedPath = `${databasePath}.restore-${stamp}.tmp`;
const previousPath = `${databasePath}.before-restore-${stamp}`;
copyFileSync(backupPath, stagedPath);
try { chmodSync(stagedPath, 0o600); } catch { /* permissions are best-effort on non-POSIX filesystems */ }

// Sign-in sessions from the backup's point in time must not come back to life
// (they may have been signed out or revoked since), so restored databases
// always start with no sessions.
try {
  // @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
  const stagedDb = new DatabaseSync(stagedPath);
  try {
    if (stagedDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'").get()) stagedDb.exec('DELETE FROM auth_sessions');
  } finally {
    stagedDb.close();
  }
} catch (error) {
  unlinkSync(stagedPath);
  throw error;
}

let liveDatabaseMoved = false;
const movedSidecars: string[] = [];
try {
  if (existsSync(databasePath)) {
    renameSync(databasePath, previousPath);
    liveDatabaseMoved = true;
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${previousPath}${suffix}`);
      movedSidecars.push(suffix);
    }
  }
  renameSync(stagedPath, databasePath);
} catch (error) {
  try {
    for (const suffix of movedSidecars) {
      const sidecar = `${databasePath}${suffix}`;
      const previousSidecar = `${previousPath}${suffix}`;
      if (!existsSync(sidecar) && existsSync(previousSidecar)) renameSync(previousSidecar, sidecar);
    }
    if (liveDatabaseMoved && !existsSync(databasePath) && existsSync(previousPath)) renameSync(previousPath, databasePath);
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
  } catch (rollbackError) {
    const original = error instanceof Error ? error.message : String(error);
    const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(`Restore failed: ${original}. Rollback also failed: ${rollback}. Check ${previousPath}.`);
  }
  throw error;
}

console.log(`Restored ${basename(databasePath)} from ${basename(backupPath)}.`);
console.log(`The previous database remains recoverable at ${previousPath}.`);
