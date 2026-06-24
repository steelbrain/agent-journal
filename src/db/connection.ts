import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from './migrations.js';
import { configRoot } from '../domain/paths.js';

export function defaultDbPath(): string {
  return process.env.AGENT_JOURNAL_DB ?? path.join(configRoot(), 'memory.db');
}

export function openDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isNew = !fs.existsSync(file);
  const db = new Database(file);
  sqliteVec.load(db);

  if (isNew) {
    db.pragma('auto_vacuum = INCREMENTAL');
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  return db;
}
