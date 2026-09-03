import { basename, dirname, resolve } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';
import { backupDatabase, openDatabase } from '../server/db';

const db = openDatabase();
try {
  const backup = backupDatabase(db);
  console.log(`Scout backup created: ${basename(backup)}`);
  // Prune old timestamped backups beside the live DB, keeping the 10 newest.
  try {
    const dir = dirname(resolve(process.env.SCOUT_DB_PATH ?? './data/scout.sqlite'));
    const base = basename(resolve(process.env.SCOUT_DB_PATH ?? './data/scout.sqlite'));
    const backups = readdirSync(dir)
      .filter((file) => file.startsWith(`${base}.`) && file.endsWith('.backup.sqlite'))
      .sort()
      .reverse();
    for (const stale of backups.slice(10)) {
      try { unlinkSync(resolve(dir, stale)); } catch { /* best-effort */ }
    }
  } catch { /* pruning is best-effort */ }
} finally {
  db.close();
}
