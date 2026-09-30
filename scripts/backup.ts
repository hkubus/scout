import { basename } from 'node:path';
import { backupDatabase, openDatabase } from '../server/db';

const db = openDatabase();
try {
  // backupDatabase keeps the 10 newest timestamped backups beside the live DB.
  const backup = backupDatabase(db);
  console.log(`Scout backup created: ${basename(backup)}`);
} finally {
  db.close();
}
