import type Database from 'better-sqlite3';

const VERSION = 1;

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= VERSION) {
    return;
  }

  db.transaction(() => {
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

    db.pragma(`user_version = ${VERSION}`);
  })();
}
