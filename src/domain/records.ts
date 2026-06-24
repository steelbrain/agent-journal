import type Database from 'better-sqlite3';
import { jsonArray } from './json.js';
import { relativeMap } from './time.js';

/** Humanized companions to the absolute timestamp fields on the same record. */
type RelativeTimes = Record<string, string>;

const STATEMENT_TS_FIELDS = ['created_at', 'last_accessed_at', 'valid_from', 'valid_to', 'invalidated_at'] as const;
const ENTITY_TS_FIELDS = ['created_at', 'last_updated_at', 'last_accessed_at', 'invalidated_at'] as const;
const JOURNAL_TS_FIELDS = ['created_at', 'invalidated_at'] as const;

export type StatementOut = {
  id: string;
  entity_id: string;
  claim: string;
  confidence_level: string;
  confidence_reason: string;
  derivation_method: string;
  citations: string[] | null;
  created_at: number;
  last_accessed_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  status: string;
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
  _relative: RelativeTimes;
};

export type EntityOut = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[] | null;
  created_at: number;
  last_updated_at: number;
  last_accessed_at: number | null;
  status: string;
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
  _relative: RelativeTimes;
};

export type JournalOut = {
  id: string;
  created_at: number;
  commands: string[] | null;
  proven: string[] | null;
  disproven: string[] | null;
  narrative: string | null;
  is_stub: boolean;
  status: string;
  superseded_by: string | null;
  invalidated_at: number | null;
  links: Array<{ target_type: string; target_id: string; role: string }>;
  _relative: RelativeTimes;
};

export function statementOut(row: {
  id: string;
  entity_id: string;
  claim: string;
  confidence_level: string;
  confidence_reason: string;
  derivation_method: string;
  citations: string | null;
  created_at: number;
  last_accessed_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  status: string;
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
}): StatementOut {
  const base = {
    id: row.id,
    entity_id: row.entity_id,
    claim: row.claim,
    confidence_level: row.confidence_level,
    confidence_reason: row.confidence_reason,
    derivation_method: row.derivation_method,
    citations: jsonArray(row.citations),
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    status: row.status,
    invalidation_note: row.invalidation_note,
    invalidated_at: row.invalidated_at,
    superseded_by: row.superseded_by,
  };
  return { ...base, _relative: relativeMap(base, STATEMENT_TS_FIELDS) };
}

export function entityOut(row: {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string | null;
  created_at: number;
  last_updated_at: number;
  last_accessed_at: number | null;
  status: string;
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
}): EntityOut {
  const base = {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    tags: jsonArray(row.tags),
    created_at: row.created_at,
    last_updated_at: row.last_updated_at,
    last_accessed_at: row.last_accessed_at,
    status: row.status,
    invalidation_note: row.invalidation_note,
    invalidated_at: row.invalidated_at,
    superseded_by: row.superseded_by,
  };
  return { ...base, _relative: relativeMap(base, ENTITY_TS_FIELDS) };
}

export function journalOut(
  db: Database.Database,
  row: {
    id: string;
    created_at: number;
    commands: string | null;
    proven: string | null;
    disproven: string | null;
    narrative: string | null;
    is_stub: number;
    status: string;
    superseded_by: string | null;
    invalidated_at: number | null;
  },
): JournalOut {
  const links = db
    .prepare(
      'SELECT target_type, target_id, role FROM journal_link WHERE journal_id = ? ORDER BY target_type, target_id, role',
    )
    .all(row.id) as Array<{ target_type: string; target_id: string; role: string }>;

  const base = {
    id: row.id,
    created_at: row.created_at,
    commands: jsonArray(row.commands),
    proven: jsonArray(row.proven),
    disproven: jsonArray(row.disproven),
    narrative: row.narrative,
    is_stub: row.is_stub === 1,
    status: row.status,
    superseded_by: row.superseded_by,
    invalidated_at: row.invalidated_at,
    links,
  };
  return { ...base, _relative: relativeMap(base, JOURNAL_TS_FIELDS) };
}

export function snippet(text: string | null | undefined, length = 200): string {
  const value = text ?? '';
  return value.length > length ? `${value.slice(0, length)}...` : value;
}
