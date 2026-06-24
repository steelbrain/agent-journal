import type Database from 'better-sqlite3';

export type FtsTable = 'fts_statements' | 'fts_journal';

export function sanitizeFtsQuery(query: string): string | null {
  const terms = query.match(/[A-Za-z0-9]+/g);
  if (!terms || terms.length === 0) {
    return null;
  }

  // Never pass raw user text to FTS5 MATCH. Quoting alphanumeric terms avoids
  // syntax errors and joins tokens broadly for recall.
  return terms.map((term) => `"${term}"`).join(' OR ');
}

export function upsertStatementFts(
  db: Database.Database,
  statementId: string,
  claim: string,
  entityTitle: string,
): void {
  deleteStatementFts(db, statementId);
  db.prepare('INSERT INTO fts_statements(statement_id, claim, entity_title) VALUES (?, ?, ?)').run(
    statementId,
    claim,
    entityTitle,
  );
}

export function deleteStatementFts(db: Database.Database, statementId: string): void {
  db.prepare('DELETE FROM fts_statements WHERE statement_id = ?').run(statementId);
}

export function upsertJournalFts(
  db: Database.Database,
  journalId: string,
  narrative: string | null | undefined,
  commands: string[] | null | undefined,
): void {
  deleteJournalFts(db, journalId);
  db.prepare('INSERT INTO fts_journal(journal_id, narrative, commands) VALUES (?, ?, ?)').run(
    journalId,
    narrative ?? '',
    commands ? JSON.stringify(commands) : '',
  );
}

export function deleteJournalFts(db: Database.Database, journalId: string): void {
  db.prepare('DELETE FROM fts_journal WHERE journal_id = ?').run(journalId);
}

export function ftsSearch(
  db: Database.Database,
  table: FtsTable,
  query: string,
  limit: number,
): Array<{ id: string; bm25: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) {
    return [];
  }

  if (table === 'fts_statements') {
    return db
      .prepare(
        'SELECT statement_id AS id, bm25(fts_statements) AS bm25 FROM fts_statements WHERE fts_statements MATCH ? ORDER BY bm25 LIMIT ?',
      )
      .all(sanitized, limit) as Array<{ id: string; bm25: number }>;
  }

  return db
    .prepare(
      'SELECT journal_id AS id, bm25(fts_journal) AS bm25 FROM fts_journal WHERE fts_journal MATCH ? ORDER BY bm25 LIMIT ?',
    )
    .all(sanitized, limit) as Array<{ id: string; bm25: number }>;
}
