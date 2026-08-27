import { basename } from 'node:path';
import { backupDatabase, openDatabase } from '../server/db';

const db = openDatabase();
try {
  const backup = backupDatabase(db);
  console.log(`Scout backup created: ${basename(backup)}`);
} finally {
  db.close();
}
