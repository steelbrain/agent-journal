import type Database from 'better-sqlite3';

const VERSION = 2;

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= VERSION) {
    return;
  }

  db.transaction(() => {
    if (current < 1) migrateV1(db);
    if (current < 2) migrateV2(db);
    db.pragma(`user_version = ${VERSION}`);
  })();
}

function migrateV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id             TEXT PRIMARY KEY,
      resolution_key TEXT NOT NULL UNIQUE,
      display_name   TEXT,
      config         TEXT,
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES project(id),
      type              TEXT NOT NULL,
      title             TEXT NOT NULL,
      summary           TEXT,
      tags              TEXT,
      created_at        INTEGER NOT NULL,
      last_updated_at   INTEGER NOT NULL,
      last_accessed_at  INTEGER,
      status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
      invalidation_note TEXT,
      invalidated_at    INTEGER,
      superseded_by     TEXT REFERENCES entity(id)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_project ON entity(project_id, status);

    CREATE TABLE IF NOT EXISTS statement (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES project(id),
      entity_id         TEXT NOT NULL REFERENCES entity(id),
      edge_id           TEXT REFERENCES relationship(id),
      claim             TEXT NOT NULL,
      confidence_level  TEXT NOT NULL CHECK (confidence_level IN ('low','medium','high','verified')),
      confidence_reason TEXT NOT NULL,
      derivation_method TEXT NOT NULL CHECK (derivation_method IN
                           ('direct-observation','command-output','user-assertion','inference','external-doc')),
      citations         TEXT,
      created_at        INTEGER NOT NULL,
      last_accessed_at  INTEGER,
      valid_from        INTEGER,
      valid_to          INTEGER,
      status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
      invalidation_note TEXT,
      invalidated_at    INTEGER,
      superseded_by     TEXT REFERENCES statement(id)
    );
    CREATE INDEX IF NOT EXISTS idx_stmt_entity   ON statement(entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_stmt_project  ON statement(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_stmt_superby  ON statement(superseded_by);
    CREATE INDEX IF NOT EXISTS idx_stmt_created  ON statement(project_id, created_at);

    CREATE TABLE IF NOT EXISTS relationship (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES project(id),
      from_entity       TEXT NOT NULL REFERENCES entity(id),
      to_entity         TEXT NOT NULL REFERENCES entity(id),
      type              TEXT NOT NULL,
      confidence_level  TEXT NOT NULL CHECK (confidence_level IN ('low','medium','high','verified')),
      confidence_reason TEXT NOT NULL,
      derivation_method TEXT NOT NULL,
      citations         TEXT,
      created_at        INTEGER NOT NULL,
      last_accessed_at  INTEGER,
      valid_from        INTEGER,
      valid_to          INTEGER,
      status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
      invalidation_note TEXT,
      invalidated_at    INTEGER,
      superseded_by     TEXT REFERENCES relationship(id)
    );

    CREATE TABLE IF NOT EXISTS journal_entry (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES project(id),
      created_at     INTEGER NOT NULL,
      commands       TEXT,
      proven         TEXT,
      disproven      TEXT,
      narrative      TEXT,
      is_stub        INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
      superseded_by  TEXT REFERENCES journal_entry(id),
      invalidated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jrnl_project ON journal_entry(project_id, created_at);

    CREATE TABLE IF NOT EXISTS journal_link (
      journal_id  TEXT NOT NULL REFERENCES journal_entry(id),
      target_type TEXT NOT NULL CHECK (target_type IN ('entity','statement','relationship','journal_entry')),
      target_id   TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('created','changed','proven','disproven','deleted')),
      PRIMARY KEY (journal_id, target_type, target_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_jlink_target ON journal_link(target_type, target_id);

    CREATE TABLE IF NOT EXISTS embedding (
      owner_type   TEXT NOT NULL CHECK (owner_type IN ('statement','journal_entry')),
      owner_id     TEXT NOT NULL,
      vec_rowid    INTEGER NOT NULL,
      model_id     TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (owner_type, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_emb_vecrow ON embedding(vec_rowid);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_index USING vec0(embedding float[384]);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_statements USING fts5(
      statement_id UNINDEXED, claim, entity_title
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_journal USING fts5(
      journal_id UNINDEXED, narrative, commands
    );
  `);
}

// v2 rebuilds the search indexes with project/status scoping so recall runs
// per project and can exclude tombstones at the index level instead of
// post-filtering a global candidate pool. Vectors are copied as raw blobs;
// no re-embedding is required.
function migrateV2(db: Database.Database): void {
  db.exec(`
    CREATE TEMP TABLE mig_vec AS
      SELECT e.owner_type   AS owner_type,
             e.owner_id     AS owner_id,
             v.embedding    AS embedding,
             COALESCE(s.project_id, j.project_id) AS project_id,
             COALESCE(s.status, j.status)         AS status
      FROM embedding e
      JOIN vec_index v ON v.rowid = e.vec_rowid
      LEFT JOIN statement s     ON e.owner_type = 'statement'     AND s.id = e.owner_id
      LEFT JOIN journal_entry j ON e.owner_type = 'journal_entry' AND j.id = e.owner_id;

    DROP TABLE vec_index;
    CREATE VIRTUAL TABLE vec_index USING vec0(
      project_id TEXT partition key,
      embedding float[384],
      owner_type TEXT,
      status TEXT
    );
  `);

  const vectors = db
    .prepare('SELECT owner_type, owner_id, embedding, project_id, status FROM mig_vec WHERE project_id IS NOT NULL')
    .all() as Array<{
    owner_type: string;
    owner_id: string;
    embedding: Buffer;
    project_id: string;
    status: string;
  }>;
  const insertVec = db.prepare('INSERT INTO vec_index(project_id, embedding, owner_type, status) VALUES (?, ?, ?, ?)');
  const remap = db.prepare('UPDATE embedding SET vec_rowid = ? WHERE owner_type = ? AND owner_id = ?');
  for (const row of vectors) {
    const inserted = insertVec.run(row.project_id, row.embedding, row.owner_type, row.status);
    remap.run(Number(inserted.lastInsertRowid), row.owner_type, row.owner_id);
  }

  db.exec(`
    DELETE FROM embedding WHERE NOT EXISTS (
      SELECT 1 FROM mig_vec m
      WHERE m.owner_type = embedding.owner_type AND m.owner_id = embedding.owner_id AND m.project_id IS NOT NULL
    );
    DROP TABLE mig_vec;

    DROP TABLE fts_statements;
    CREATE VIRTUAL TABLE fts_statements USING fts5(
      statement_id UNINDEXED, claim, entity_title, project_id UNINDEXED, status UNINDEXED
    );
    INSERT INTO fts_statements(statement_id, claim, entity_title, project_id, status)
      SELECT s.id, s.claim, e.title, s.project_id, s.status
      FROM statement s JOIN entity e ON e.id = s.entity_id;

    DROP TABLE fts_journal;
    CREATE VIRTUAL TABLE fts_journal USING fts5(
      journal_id UNINDEXED, narrative, commands, project_id UNINDEXED, status UNINDEXED
    );
    INSERT INTO fts_journal(journal_id, narrative, commands, project_id, status)
      SELECT id, narrative, COALESCE(commands, ''), project_id, status
      FROM journal_entry
      WHERE narrative IS NOT NULL AND narrative != '';
  `);
}
