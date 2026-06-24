import type Database from 'better-sqlite3';

export function maybeVacuum(db: Database.Database, random = Math.random): void {
  if (random() < 0.1) {
    db.pragma('incremental_vacuum');
  }
}
