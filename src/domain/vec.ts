import type Database from 'better-sqlite3';

export type VectorOwnerType = 'statement' | 'journal_entry';
export type VectorStatus = 'active' | 'invalid';

function vectorJson(vec: Float32Array): string {
  return JSON.stringify(Array.from(vec));
}

export function upsertVector(
  db: Database.Database,
  ownerType: VectorOwnerType,
  ownerId: string,
  vec: Float32Array,
  modelId: string,
  dim: number,
  contentHash: string,
  projectId: string,
  status: VectorStatus,
): void {
  const existing = db
    .prepare('SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?')
    .get(ownerType, ownerId) as { vec_rowid: number } | undefined;

  if (existing) {
    db.prepare('DELETE FROM vec_index WHERE rowid = ?').run(existing.vec_rowid);
  }

  const insert = db
    .prepare('INSERT INTO vec_index(project_id, embedding, owner_type, status) VALUES (?, ?, ?, ?)')
    .run(projectId, vectorJson(vec), ownerType, status);
  const vecRowid = Number(insert.lastInsertRowid);
  db.prepare(
    `INSERT INTO embedding(owner_type, owner_id, vec_rowid, model_id, dim, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET
       vec_rowid = excluded.vec_rowid,
       model_id = excluded.model_id,
       dim = excluded.dim,
       content_hash = excluded.content_hash`,
  ).run(ownerType, ownerId, vecRowid, modelId, dim, contentHash);
}

export function setVectorStatus(
  db: Database.Database,
  ownerType: VectorOwnerType,
  ownerId: string,
  status: VectorStatus,
): void {
  const existing = db
    .prepare('SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?')
    .get(ownerType, ownerId) as { vec_rowid: number } | undefined;

  if (existing) {
    db.prepare('UPDATE vec_index SET status = ? WHERE rowid = ?').run(status, existing.vec_rowid);
  }
}

export function deleteVector(db: Database.Database, ownerType: VectorOwnerType, ownerId: string): void {
  const existing = db
    .prepare('SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?')
    .get(ownerType, ownerId) as { vec_rowid: number } | undefined;

  if (existing) {
    db.prepare('DELETE FROM vec_index WHERE rowid = ?').run(existing.vec_rowid);
    db.prepare('DELETE FROM embedding WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
  }
}

export function knn(
  db: Database.Database,
  queryVec: Float32Array,
  limit: number,
  projectId: string,
  ownerType: VectorOwnerType,
  includeInvalid: boolean,
): Array<{ owner_id: string; distance: number }> {
  // The partition key and metadata filters run inside the KNN scan, so the
  // full k budget goes to this project and owner type instead of a global
  // mixed pool that gets filtered after the fact.
  const statusFilter = includeInvalid ? '' : "AND v.status = 'active'";
  const rows = db
    .prepare(
      `SELECT e.owner_id, v.distance
       FROM vec_index v
       JOIN embedding e ON e.vec_rowid = v.rowid
       WHERE v.embedding MATCH ? AND v.k = ? AND v.project_id = ? AND v.owner_type = ? ${statusFilter}
       ORDER BY v.distance`,
    )
    .all(vectorJson(queryVec), limit, projectId, ownerType) as Array<{
    owner_id: string;
    distance: number;
  }>;

  return rows;
}
