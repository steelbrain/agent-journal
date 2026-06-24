import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { resolveConfig, type MemoryConfig } from '../config.js';
import type { Embeddings } from '../domain/embeddings.js';
import {
  ftsSearch,
  upsertJournalFts,
  upsertStatementFts,
  deleteJournalFts,
  deleteStatementFts,
} from '../domain/fts.js';
import { hasAllTags, jsonStringifyArray } from '../domain/json.js';
import { idKind, newId, type IdKind } from '../domain/ids.js';
import type { ProjectContext, ProjectResolver } from '../domain/project.js';
import { entityOut, journalOut, snippet, statementOut } from '../domain/records.js';
import { humanizeRelative, parseDurationMs, now, relativeMap } from '../domain/time.js';
import { deleteVector, knn, upsertVector, type VectorOwnerType } from '../domain/vec.js';
import { maybeVacuum } from '../domain/vacuum.js';
import { AGENTS_MD_SNIPPET } from '../text/snippet.js';
import { GUIDE } from '../text/guide.js';
import { withRetry } from '../util/retry.js';
import {
  emptySchema,
  journalAppendSchema,
  kbAddStatementSchema,
  kbDeleteSchema,
  kbEditStatementSchema,
  kbInvalidateSchema,
  kbUpsertEntitySchema,
  memoryGetSchema,
  memoryRecentSchema,
  memorySearchSchema,
  memoryStatsSchema,
} from './schemas.js';

type EntityRow = {
  id: string;
  project_id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string | null;
  created_at: number;
  last_updated_at: number;
  last_accessed_at: number | null;
  status: 'active' | 'invalid';
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
};

type StatementRow = {
  id: string;
  project_id: string;
  entity_id: string;
  edge_id: string | null;
  claim: string;
  confidence_level: 'low' | 'medium' | 'high' | 'verified';
  confidence_reason: string;
  derivation_method: 'direct-observation' | 'command-output' | 'user-assertion' | 'inference' | 'external-doc';
  citations: string | null;
  created_at: number;
  last_accessed_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  status: 'active' | 'invalid';
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
};

type JournalRow = {
  id: string;
  project_id: string;
  created_at: number;
  commands: string | null;
  proven: string | null;
  disproven: string | null;
  narrative: string | null;
  is_stub: number;
  status: 'active' | 'invalid';
  superseded_by: string | null;
  invalidated_at: number | null;
};

type RelationshipRow = {
  id: string;
  project_id: string;
  from_entity: string;
  to_entity: string;
  type: string;
  confidence_level: string;
  confidence_reason: string;
  derivation_method: string;
  citations: string | null;
  created_at: number;
  last_accessed_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  status: 'active' | 'invalid';
  invalidation_note: string | null;
  invalidated_at: number | null;
  superseded_by: string | null;
};

type StatementSearchRow = StatementRow & {
  entity_type: string;
  entity_title: string;
  entity_tags: string | null;
};

type Candidate = {
  kind: 'statement' | 'journal';
  id: string;
  created_at: number;
  status: string;
  rawRrf: number;
  score: number;
  statement?: StatementSearchRow;
  journal?: JournalRow;
};

function statementDocumentText(claim: string, entityTitle: string): string {
  return `${claim}\n${entityTitle}`;
}

const RELATIONSHIP_TS_FIELDS = ['created_at', 'last_accessed_at', 'valid_from', 'valid_to', 'invalidated_at'] as const;

function relationshipOut(row: RelationshipRow): RelationshipRow & { _relative: Record<string, string> } {
  return { ...row, _relative: relativeMap(row, RELATIONSHIP_TS_FIELDS) };
}

function rankMap(ids: string[]): Map<string, number> {
  const map = new Map<string, number>();
  ids.forEach((id, index) => {
    if (!map.has(id)) {
      map.set(id, index + 1);
    }
  });
  return map;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

function scoreRecency(createdAt: number, timestamp: number, config: MemoryConfig): number {
  const ageDays = Math.max(0, (timestamp - createdAt) / 86_400_000);
  const halfLifeDays = parseDurationMs(config.recency_half_life) / 86_400_000;
  return 0.5 ** (ageDays / halfLifeDays);
}

function dbTargetForKind(kind: IdKind): {
  table: string;
  targetType: 'entity' | 'statement' | 'relationship' | 'journal_entry';
  vectorOwner?: VectorOwnerType;
} | null {
  switch (kind) {
    case 'entity':
      return { table: 'entity', targetType: 'entity' };
    case 'statement':
      return { table: 'statement', targetType: 'statement', vectorOwner: 'statement' };
    case 'relationship':
      return { table: 'relationship', targetType: 'relationship' };
    case 'journal':
      return { table: 'journal_entry', targetType: 'journal_entry', vectorOwner: 'journal_entry' };
    default:
      return null;
  }
}

export type MemoryApiOptions = {
  db: Database.Database;
  resolver: ProjectResolver;
  embeddings: Embeddings;
  dbFile: string;
  random?: () => number;
};

export class MemoryApi {
  private readonly db: Database.Database;
  private readonly resolver: ProjectResolver;
  private readonly embeddings: Embeddings;
  private readonly dbFile: string;
  private readonly random: () => number;

  constructor(options: MemoryApiOptions) {
    this.db = options.db;
    this.resolver = options.resolver;
    this.embeddings = options.embeddings;
    this.dbFile = options.dbFile;
    this.random = options.random ?? Math.random;
  }

  async search(input: unknown) {
    const args = memorySearchSchema.parse(input);
    const project = this.project(args.project);
    const config = this.config(project);
    const timestamp = now();

    await this.embeddings.ready();
    const queryVec = await this.embeddings.embedQuery(args.query);
    const candidates: Candidate[] = [];

    if (args.where === 'knowledge-base' || args.where === 'both') {
      candidates.push(
        ...this.searchStatements(args.query, queryVec, project, config, timestamp, {
          type: args.type,
          tags: args.tags,
          includeInvalid: args.include_invalid,
          includeDeletedSince: args.include_deleted_since,
        }),
      );
    }

    if (args.where === 'journal' || args.where === 'both') {
      candidates.push(
        ...this.searchJournal(args.query, queryVec, project, config, timestamp, {
          includeInvalid: args.include_invalid,
          includeDeletedSince: args.include_deleted_since,
        }),
      );
    }

    if (candidates.length > 0) {
      const min = Math.min(...candidates.map((candidate) => candidate.rawRrf));
      const max = Math.max(...candidates.map((candidate) => candidate.rawRrf));
      for (const candidate of candidates) {
        const rrfNorm = max === min ? 1 : (candidate.rawRrf - min) / (max - min);
        let trust = 0;
        if (candidate.statement) {
          trust =
            config.trust_confidence[candidate.statement.confidence_level] +
            config.trust_derivation[candidate.statement.derivation_method];
        }

        candidate.score =
          rrfNorm + config.w_recency * scoreRecency(candidate.created_at, timestamp, config) + config.w_trust * trust;
      }
    }

    const top = candidates
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at || b.id.localeCompare(a.id))
      .slice(0, args.limit);

    const entityGroups = new Map<
      string,
      {
        entity: { id: string; type: string; title: string };
        statements: Array<{
          kind: 'statement';
          id: string;
          claim_snippet: string;
          score: number;
          confidence_level: string;
          derivation_method: string;
          status: string;
          created_at: number;
          _relative: Record<string, string>;
        }>;
      }
    >();
    const journal = [];

    for (const hit of top) {
      if (hit.kind === 'statement' && hit.statement) {
        const row = hit.statement;
        const group = entityGroups.get(row.entity_id) ?? {
          entity: { id: row.entity_id, type: row.entity_type, title: row.entity_title },
          statements: [],
        };
        group.statements.push({
          kind: 'statement',
          id: row.id,
          claim_snippet: snippet(row.claim),
          score: hit.score,
          confidence_level: row.confidence_level,
          derivation_method: row.derivation_method,
          status: row.status,
          created_at: row.created_at,
          _relative: { created_at: humanizeRelative(row.created_at, timestamp) },
        });
        entityGroups.set(row.entity_id, group);
      } else if (hit.kind === 'journal' && hit.journal) {
        journal.push({
          kind: 'journal' as const,
          id: hit.journal.id,
          narrative_snippet: snippet(hit.journal.narrative),
          score: hit.score,
          status: hit.journal.status,
          created_at: hit.journal.created_at,
          _relative: { created_at: humanizeRelative(hit.journal.created_at, timestamp) },
        });
      }
    }

    return {
      query: args.query,
      where: args.where,
      project: project.id,
      entities: [...entityGroups.values()],
      journal,
      total_returned: top.length,
    };
  }

  get(input: unknown) {
    const args = memoryGetSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);

    if (kind === 'statement') {
      const row = this.loadStatement(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      withRetry(() =>
        this.db.transaction(() => {
          this.db.prepare('UPDATE statement SET last_accessed_at = ? WHERE id = ?').run(now(), args.id);
        })(),
      );
      const fresh = this.loadStatement(args.id, project.id);
      const entity = this.loadEntity(fresh!.entity_id, project.id);
      let redirect = undefined;
      if (fresh!.status === 'invalid' && fresh!.superseded_by) {
        const target = this.loadStatement(fresh!.superseded_by, project.id);
        if (target) redirect = statementOut(target);
      }
      return {
        kind: 'statement',
        statement: statementOut(fresh!),
        entity: entity ? { id: entity.id, type: entity.type, title: entity.title } : null,
        ...(redirect ? { redirect } : {}),
        flagged_invalid: fresh!.status === 'invalid',
      };
    }

    if (kind === 'entity') {
      const row = this.loadEntity(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      withRetry(() =>
        this.db.transaction(() => {
          this.db.prepare('UPDATE entity SET last_accessed_at = ? WHERE id = ?').run(now(), args.id);
        })(),
      );
      const fresh = this.loadEntity(args.id, project.id)!;
      const statements = this.db
        .prepare(
          `SELECT * FROM statement
           WHERE entity_id = ? AND project_id = ? ${args.include_invalid_statements ? '' : "AND status = 'active'"}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(args.id, project.id) as StatementRow[];
      return {
        kind: 'entity',
        entity: entityOut(fresh),
        statements: statements.map(statementOut),
      };
    }

    if (kind === 'journal') {
      const row = this.loadJournal(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      return { kind: 'journal', entry: journalOut(this.db, row) };
    }

    if (kind === 'relationship') {
      const row = this.loadRelationship(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      return { kind: 'relationship', relationship: relationshipOut(row) };
    }

    throw new Error(`No record found for id ${args.id}`);
  }

  upsertEntity(input: unknown) {
    const args = kbUpsertEntitySchema.parse(input);
    const project = this.project(args.project);

    const result = this.runMutation(() => {
      const timestamp = now();
      if (!args.id) {
        const id = newId('entity');
        this.db
          .prepare(
            `INSERT INTO entity(id, project_id, type, title, summary, tags, created_at, last_updated_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(
            id,
            project.id,
            args.type,
            args.title,
            args.summary ?? null,
            jsonStringifyArray(args.tags),
            timestamp,
            timestamp,
          );
        return entityOut(this.loadEntity(id, project.id)!);
      }

      const existing = this.loadEntity(args.id, project.id);
      if (!existing) throw new Error(`No active entity found for id ${args.id}`);
      if (existing.status !== 'active') {
        throw new Error(`Entity ${args.id} is invalid and read-only`);
      }

      this.db
        .prepare(
          `UPDATE entity
           SET type = ?, title = ?, summary = ?, tags = ?, last_updated_at = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(
          args.type,
          args.title,
          args.summary ?? existing.summary,
          args.tags === undefined ? existing.tags : JSON.stringify(args.tags),
          timestamp,
          args.id,
          project.id,
        );

      const statements = this.db
        .prepare('SELECT id, claim FROM statement WHERE entity_id = ? AND project_id = ?')
        .all(args.id, project.id) as Array<{ id: string; claim: string }>;
      for (const statement of statements) {
        upsertStatementFts(this.db, statement.id, statement.claim, args.title);
      }

      return entityOut(this.loadEntity(args.id, project.id)!);
    });

    return result;
  }

  async addStatement(input: unknown) {
    const args = kbAddStatementSchema.parse(input);
    const project = this.project(args.project);
    const entity = this.loadEntity(args.entity_id, project.id);
    if (!entity) throw new Error(`No active entity found for id ${args.entity_id}`);
    if (entity.status !== 'active') {
      throw new Error(`Entity ${args.entity_id} is invalid and read-only`);
    }

    const statementId = newId('statement');
    const statementVec = await this.embeddings.embedDocument(statementDocumentText(args.claim, entity.title));
    const statementHash = this.embeddings.contentHash(statementDocumentText(args.claim, entity.title));
    const stubJournalId = args.journal_entry_id ? null : newId('journal');
    const stubNarrative = stubJournalId ? `auto-stub for statement ${statementId}` : null;
    const stubVec = stubNarrative ? await this.embeddings.embedDocument(stubNarrative) : null;
    const stubHash = stubNarrative ? this.embeddings.contentHash(stubNarrative) : null;

    const result = this.runMutation(() => {
      const timestamp = now();
      let journalEntryId = args.journal_entry_id ?? stubJournalId!;

      if (args.journal_entry_id) {
        this.requireJournal(args.journal_entry_id, project.id);
      } else {
        this.insertJournal(stubJournalId!, project.id, timestamp, null, null, null, stubNarrative, true);
        upsertJournalFts(this.db, stubJournalId!, stubNarrative, null);
        upsertVector(
          this.db,
          'journal_entry',
          stubJournalId!,
          stubVec!,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          stubHash!,
        );
      }

      this.insertStatement({
        id: statementId,
        projectId: project.id,
        entityId: entity.id,
        claim: args.claim,
        confidenceLevel: args.confidence_level,
        confidenceReason: args.confidence_reason,
        derivationMethod: args.derivation_method,
        citations: args.citations,
        createdAt: timestamp,
        validFrom: args.valid_from ?? null,
        validTo: args.valid_to ?? null,
      });
      upsertVector(
        this.db,
        'statement',
        statementId,
        statementVec,
        this.embeddings.modelId(),
        this.embeddings.dim(),
        statementHash,
      );
      upsertStatementFts(this.db, statementId, args.claim, entity.title);
      this.insertJournalLink(journalEntryId, 'statement', statementId, 'created');

      return {
        statement: statementOut(this.loadStatement(statementId, project.id)!),
        journal_entry_id: journalEntryId,
        ...(stubJournalId
          ? {
              nudge: `Recorded with an auto-created journal stub (${stubJournalId}). Consider journal.append with what you did and what it proves, then link it.`,
            }
          : {}),
      };
    });

    return result;
  }

  async editStatement(input: unknown) {
    const args = kbEditStatementSchema.parse(input);
    const valueFields = [
      'claim',
      'confidence_level',
      'confidence_reason',
      'derivation_method',
      'citations',
      'valid_from',
      'valid_to',
    ] as const;
    if (!valueFields.some((field) => args[field] !== undefined)) {
      throw new Error('nothing to edit');
    }

    const project = this.project(args.project);
    const target = this.loadStatement(args.statement_id, project.id);
    if (!target) throw new Error(`No active statement found for id ${args.statement_id}`);
    if (target.status !== 'active') {
      throw new Error(`Statement ${args.statement_id} is invalid and read-only`);
    }
    const entity = this.loadEntity(target.entity_id, project.id);
    if (!entity) throw new Error(`No entity found for statement ${target.id}`);

    const replacement = {
      claim: args.claim ?? target.claim,
      confidenceLevel: args.confidence_level ?? target.confidence_level,
      confidenceReason: args.confidence_reason ?? target.confidence_reason,
      derivationMethod: args.derivation_method ?? target.derivation_method,
      citations:
        args.citations === undefined
          ? target.citations
            ? (JSON.parse(target.citations) as string[])
            : undefined
          : args.citations,
      validFrom: args.valid_from ?? target.valid_from,
      validTo: args.valid_to ?? target.valid_to,
    };

    const newStatementId = newId('statement');
    const documentText = statementDocumentText(replacement.claim, entity.title);
    const statementVec = await this.embeddings.embedDocument(documentText);
    const statementHash = this.embeddings.contentHash(documentText);
    const stubJournalId = args.journal_entry_id ? null : newId('journal');
    const stubNarrative = stubJournalId ? `auto-stub for statement ${newStatementId}` : null;
    const stubVec = stubNarrative ? await this.embeddings.embedDocument(stubNarrative) : null;
    const stubHash = stubNarrative ? this.embeddings.contentHash(stubNarrative) : null;

    return this.runMutation(() => {
      const timestamp = now();
      const journalEntryId = args.journal_entry_id ?? stubJournalId!;
      if (args.journal_entry_id) {
        this.requireJournal(args.journal_entry_id, project.id);
      } else {
        this.insertJournal(stubJournalId!, project.id, timestamp, null, null, null, stubNarrative, true);
        upsertJournalFts(this.db, stubJournalId!, stubNarrative, null);
        upsertVector(
          this.db,
          'journal_entry',
          stubJournalId!,
          stubVec!,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          stubHash!,
        );
      }

      this.insertStatement({
        id: newStatementId,
        projectId: project.id,
        entityId: target.entity_id,
        claim: replacement.claim,
        confidenceLevel: replacement.confidenceLevel,
        confidenceReason: replacement.confidenceReason,
        derivationMethod: replacement.derivationMethod,
        citations: replacement.citations,
        createdAt: timestamp,
        validFrom: replacement.validFrom,
        validTo: replacement.validTo,
      });
      upsertVector(
        this.db,
        'statement',
        newStatementId,
        statementVec,
        this.embeddings.modelId(),
        this.embeddings.dim(),
        statementHash,
      );
      upsertStatementFts(this.db, newStatementId, replacement.claim, entity.title);

      this.db
        .prepare(
          `UPDATE statement
           SET status = 'invalid', invalidated_at = ?, superseded_by = ?, invalidation_note = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(
          timestamp,
          newStatementId,
          args.invalidation_note ?? `edited -> superseded by ${newStatementId}`,
          target.id,
          project.id,
        );

      this.insertJournalLink(journalEntryId, 'statement', newStatementId, 'created');
      this.insertJournalLink(journalEntryId, 'statement', newStatementId, 'changed');

      return {
        statement: statementOut(this.loadStatement(newStatementId, project.id)!),
        superseded: target.id,
        journal_entry_id: journalEntryId,
        ...(stubJournalId
          ? {
              nudge: `Recorded with an auto-created journal stub (${stubJournalId}). Consider journal.append with what you did and what it proves, then link it.`,
            }
          : {}),
      };
    });
  }

  invalidate(input: unknown) {
    const args = kbInvalidateSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);
    const target = kind ? dbTargetForKind(kind) : null;
    if (!target || target.targetType === 'journal_entry') {
      throw new Error(`No record found for id ${args.id}`);
    }

    return this.runMutation(() => {
      const row = this.loadRecord(target.table, args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      if (row.status !== 'active') {
        throw new Error(`Record ${args.id} is invalid and read-only`);
      }

      if (args.superseded_by) {
        const supersedingKind = idKind(args.superseded_by);
        const supersedingTarget = supersedingKind ? dbTargetForKind(supersedingKind) : null;
        if (!supersedingTarget || supersedingTarget.table !== target.table) {
          throw new Error('superseded_by must reference the same record type');
        }
        if (!this.loadRecord(target.table, args.superseded_by, project.id)) {
          throw new Error(`No record found for superseded_by ${args.superseded_by}`);
        }
      }

      const invalidatedAt = now();
      this.db
        .prepare(
          `UPDATE ${target.table}
           SET status = 'invalid', invalidated_at = ?, invalidation_note = ?, superseded_by = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(invalidatedAt, args.note, args.superseded_by ?? null, args.id, project.id);

      if (target.table === 'statement') return statementOut(this.loadStatement(args.id, project.id)!);
      if (target.table === 'entity') {
        // Cascade to the entity's own active statements so a retired entity
        // never leaves live claims dangling behind it. superseded_by is left
        // null on the children — the entity's redirect is entity-typed and
        // cannot stand in for a statement.
        const cascade = this.db
          .prepare(
            `UPDATE statement
             SET status = 'invalid', invalidated_at = ?, invalidation_note = ?
             WHERE entity_id = ? AND project_id = ? AND status = 'active'`,
          )
          .run(invalidatedAt, `Parent entity ${args.id} retired: ${args.note}`, args.id, project.id);
        return { ...entityOut(this.loadEntity(args.id, project.id)!), cascaded_statements: cascade.changes };
      }
      return relationshipOut(this.loadRelationship(args.id, project.id)!);
    });
  }

  async appendJournal(input: unknown) {
    const args = journalAppendSchema.parse(input);
    if (
      args.narrative === undefined &&
      args.commands === undefined &&
      args.proven === undefined &&
      args.disproven === undefined &&
      args.links === undefined
    ) {
      throw new Error('journal.append requires at least one of narrative, commands, proven, disproven, or links');
    }

    const project = this.project(args.project);
    const journalId = newId('journal');
    const narrative = args.narrative ?? null;
    const shouldIndex = narrative !== null && narrative.length > 0;
    const vec = shouldIndex ? await this.embeddings.embedDocument(narrative) : null;
    const hash = shouldIndex ? this.embeddings.contentHash(narrative) : null;

    return this.runMutation(() => {
      const timestamp = now();
      for (const statementId of args.proven ?? []) {
        this.requireStatement(statementId, project.id);
      }
      for (const statementId of args.disproven ?? []) {
        this.requireStatement(statementId, project.id);
      }
      for (const link of args.links ?? []) {
        this.requireTarget(link.target_type, link.target_id, project.id);
      }

      this.insertJournal(
        journalId,
        project.id,
        timestamp,
        args.commands ?? null,
        args.proven ?? null,
        args.disproven ?? null,
        narrative,
        false,
      );

      for (const link of args.links ?? []) {
        this.insertJournalLink(journalId, link.target_type, link.target_id, link.role);
      }
      for (const statementId of args.proven ?? []) {
        this.insertJournalLink(journalId, 'statement', statementId, 'proven');
      }
      for (const statementId of args.disproven ?? []) {
        this.insertJournalLink(journalId, 'statement', statementId, 'disproven');
      }

      if (shouldIndex) {
        upsertJournalFts(this.db, journalId, narrative, args.commands ?? null);
        upsertVector(
          this.db,
          'journal_entry',
          journalId,
          vec!,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          hash!,
        );
      }

      return journalOut(this.db, this.loadJournal(journalId, project.id)!);
    });
  }

  delete(input: unknown) {
    const args = kbDeleteSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);
    const target = kind ? dbTargetForKind(kind) : null;
    if (!target) {
      throw new Error(`No record found for id ${args.id}`);
    }

    const result = withRetry(() =>
      this.db.transaction(() => {
        const row = this.loadRecord(target.table, args.id, project.id);
        if (!row) throw new Error(`No record found for id ${args.id}`);

        const isJournalTarget = target.table === 'journal_entry';
        const timestamp = now();

        // Deleting a journal entry must not spawn a fresh journal entry — the journal is
        // the audit log itself, so an audit record only makes sense for KB deletions.
        let journalId: string | null = null;
        if (!isJournalTarget) {
          journalId = newId('journal');
          this.insertJournal(
            journalId,
            project.id,
            timestamp,
            null,
            null,
            null,
            `DELETED ${target.targetType} ${args.id}: ${args.reason}`,
            false,
          );
          this.insertJournalLink(
            journalId,
            target.targetType as 'entity' | 'statement' | 'relationship' | 'journal_entry',
            args.id,
            'deleted',
          );
        }

        if (isJournalTarget) {
          this.db
            .prepare('UPDATE journal_entry SET superseded_by = NULL WHERE superseded_by = ? AND project_id = ?')
            .run(args.id, project.id);
        } else {
          this.db
            .prepare(
              `UPDATE ${target.table}
               SET superseded_by = NULL,
                   invalidation_note = COALESCE(invalidation_note, '') || ?
               WHERE superseded_by = ? AND project_id = ?`,
            )
            .run(` [redirect target deleted ${args.id}]`, args.id, project.id);
        }

        if (isJournalTarget) {
          // Drop both inbound links (other journals pointing here) and this journal's own
          // outbound links so the foreign-key delete below succeeds.
          this.db
            .prepare('DELETE FROM journal_link WHERE (target_type = ? AND target_id = ?) OR journal_id = ?')
            .run(target.targetType, args.id, args.id);
        } else {
          this.db
            .prepare(
              "DELETE FROM journal_link WHERE target_type = ? AND target_id = ? AND NOT (journal_id = ? AND role = 'deleted')",
            )
            .run(target.targetType, args.id, journalId);
        }

        if (target.vectorOwner) {
          deleteVector(this.db, target.vectorOwner, args.id);
        }
        if (target.table === 'statement') {
          deleteStatementFts(this.db, args.id);
        } else if (target.table === 'journal_entry') {
          deleteJournalFts(this.db, args.id);
        }

        this.db.prepare(`DELETE FROM ${target.table} WHERE id = ? AND project_id = ?`).run(args.id, project.id);

        return { deleted: args.id, target_type: target.targetType, journal_entry_id: journalId };
      })(),
    );

    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    return result;
  }

  recent(input: unknown) {
    const args = memoryRecentSchema.parse(input);
    const project = this.project(args.project);
    const includeKb = args.where === 'knowledge-base' || args.where === 'both';
    const includeJournal = args.where === 'journal' || args.where === 'both';
    const rows: Array<{
      kind: 'entity' | 'statement' | 'journal';
      id: string;
      created_at: number;
      title_or_snippet: string;
    }> = [];

    if (includeKb && (!args.kind || args.kind === 'entity')) {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT 'entity' AS kind, id, created_at, title AS title_or_snippet
             FROM entity
             WHERE project_id = ? ${args.include_invalid ? '' : "AND status = 'active'"} ${
               args.before ? 'AND created_at < ?' : ''
}`,
          )
          .all(...(args.before ? [project.id, args.before] : [project.id])) as typeof rows),
      );
    }

    if (includeKb && (!args.kind || args.kind === 'statement')) {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT 'statement' AS kind, id, created_at, claim AS title_or_snippet
             FROM statement
             WHERE project_id = ? ${args.include_invalid ? '' : "AND status = 'active'"} ${
               args.before ? 'AND created_at < ?' : ''
}`,
          )
          .all(...(args.before ? [project.id, args.before] : [project.id])) as typeof rows),
      );
    }

    if (includeJournal && (!args.kind || args.kind === 'journal')) {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT 'journal' AS kind, id, created_at, COALESCE(narrative, commands, '') AS title_or_snippet
             FROM journal_entry
             WHERE project_id = ? ${args.include_invalid ? '' : "AND status = 'active'"} ${
               args.before ? 'AND created_at < ?' : ''
}`,
          )
          .all(...(args.before ? [project.id, args.before] : [project.id])) as typeof rows),
      );
    }

    const reference = now();
    const sorted = rows
      .map((row) => ({
        ...row,
        title_or_snippet: snippet(row.title_or_snippet),
        _relative: { created_at: humanizeRelative(row.created_at, reference) },
      }))
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    const page = sorted.slice(0, args.limit);
    const last = page.at(-1);
    const totalRemaining = last ? sorted.filter((row) => row.created_at < last.created_at).length : 0;
    const oldest = sorted.length ? Math.min(...sorted.map((row) => row.created_at)) : null;
    const nextBefore = totalRemaining > 0 && last ? last.created_at : null;

    return {
      items: page,
      next_before: nextBefore,
      total_remaining: totalRemaining,
      oldest_record_date: oldest,
      _relative: relativeMap(
        { next_before: nextBefore, oldest_record_date: oldest },
        ['next_before', 'oldest_record_date'],
        reference,
      ),
    };
  }

  stats(input: unknown) {
    const args = memoryStatsSchema.parse(input);
    const project = this.project(args.project);
    const countByStatus = (table: string) =>
      this.db
        .prepare(`SELECT status, COUNT(*) AS count FROM ${table} WHERE project_id = ? GROUP BY status`)
        .all(project.id) as Array<{ status: string; count: number }>;

    return {
      project: project.id,
      entities: countByStatus('entity'),
      statements: countByStatus('statement'),
      journal: countByStatus('journal_entry'),
      embeddings: (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM embedding e
             WHERE (
               e.owner_type = 'statement'
               AND EXISTS (
                 SELECT 1 FROM statement s
                 WHERE s.id = e.owner_id AND s.project_id = ?
               )
             ) OR (
               e.owner_type = 'journal_entry'
               AND EXISTS (
                 SELECT 1 FROM journal_entry j
                 WHERE j.id = e.owner_id AND j.project_id = ?
               )
             )`,
          )
          .get(project.id, project.id) as { count: number }
      ).count,
      db_file_size: fs.existsSync(this.dbFile) ? fs.statSync(this.dbFile).size : 0,
      model_id: this.embeddings.modelId(),
      dim: this.embeddings.dim(),
      freelist_count: this.db.pragma('freelist_count', { simple: true }) as number,
    };
  }

  guide(input: unknown) {
    emptySchema.parse(input);
    return { guide: GUIDE };
  }

  agentsMdSnippet(input: unknown) {
    emptySchema.parse(input);
    return { snippet: AGENTS_MD_SNIPPET };
  }

  private searchStatements(
    query: string,
    queryVec: Float32Array,
    project: ProjectContext,
    config: MemoryConfig,
    timestamp: number,
    filters: {
      type?: string;
      tags?: string[];
      includeInvalid: boolean;
      includeDeletedSince?: string;
    },
  ): Candidate[] {
    const ftsIds = ftsSearch(this.db, 'fts_statements', query, config.k_recall_fts).map((row) => row.id);
    const vecIds = knn(this.db, queryVec, config.k_recall_vec)
      .filter((row) => row.owner_type === 'statement')
      .map((row) => row.owner_id);
    const ids = unique([...ftsIds, ...vecIds]);
    if (ids.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT s.*, e.type AS entity_type, e.title AS entity_title, e.tags AS entity_tags
         FROM statement s
         JOIN entity e ON e.id = s.entity_id
         WHERE s.id IN (${placeholders(ids)})`,
      )
      .all(...ids) as StatementSearchRow[];
    const ftsRanks = rankMap(ftsIds);
    const vecRanks = rankMap(vecIds);

    return rows
      .filter((row) => row.project_id === project.id)
      .filter((row) => !filters.type || row.entity_type === filters.type)
      .filter((row) => hasAllTags(row.entity_tags, filters.tags))
      .filter((row) =>
        this.visibleByStatus(
          'statement',
          row.id,
          row.status,
          row.invalidated_at,
          filters.includeInvalid,
          filters.includeDeletedSince,
          config,
          timestamp,
        ),
      )
      .map((row) => {
        const rawRrf =
          (ftsRanks.has(row.id) ? 1 / (config.rrf_k + ftsRanks.get(row.id)!) : 0) +
          (vecRanks.has(row.id) ? 1 / (config.rrf_k + vecRanks.get(row.id)!) : 0);
        return {
          kind: 'statement' as const,
          id: row.id,
          created_at: row.created_at,
          status: row.status,
          rawRrf,
          score: 0,
          statement: row,
        };
      });
  }

  private searchJournal(
    query: string,
    queryVec: Float32Array,
    project: ProjectContext,
    config: MemoryConfig,
    timestamp: number,
    filters: {
      includeInvalid: boolean;
      includeDeletedSince?: string;
    },
  ): Candidate[] {
    const ftsIds = ftsSearch(this.db, 'fts_journal', query, config.k_recall_fts).map((row) => row.id);
    const vecIds = knn(this.db, queryVec, config.k_recall_vec)
      .filter((row) => row.owner_type === 'journal_entry')
      .map((row) => row.owner_id);
    const ids = unique([...ftsIds, ...vecIds]);
    if (ids.length === 0) return [];

    const rows = this.db
      .prepare(`SELECT * FROM journal_entry WHERE id IN (${placeholders(ids)})`)
      .all(...ids) as JournalRow[];
    const ftsRanks = rankMap(ftsIds);
    const vecRanks = rankMap(vecIds);

    return rows
      .filter((row) => row.project_id === project.id)
      .filter((row) =>
        this.visibleByStatus(
          'journal_entry',
          row.id,
          row.status,
          row.invalidated_at,
          filters.includeInvalid,
          filters.includeDeletedSince,
          config,
          timestamp,
        ),
      )
      .map((row) => {
        const rawRrf =
          (ftsRanks.has(row.id) ? 1 / (config.rrf_k + ftsRanks.get(row.id)!) : 0) +
          (vecRanks.has(row.id) ? 1 / (config.rrf_k + vecRanks.get(row.id)!) : 0);
        return {
          kind: 'journal' as const,
          id: row.id,
          created_at: row.created_at,
          status: row.status,
          rawRrf,
          score: 0,
          journal: row,
        };
      });
  }

  private visibleByStatus(
    table: 'statement' | 'entity' | 'relationship' | 'journal_entry',
    id: string,
    status: 'active' | 'invalid',
    invalidatedAt: number | null,
    includeInvalid: boolean,
    includeDeletedSince: string | undefined,
    config: MemoryConfig,
    timestamp: number,
  ): boolean {
    if (status === 'active') return true;
    if (!includeInvalid) return false;

    const window = parseDurationMs(includeDeletedSince ?? config.tombstone_window);
    if (invalidatedAt !== null && invalidatedAt >= timestamp - window) {
      return true;
    }

    return this.hasLiveRedirectTo(table, id);
  }

  private hasLiveRedirectTo(table: string, id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM ${table} WHERE status = 'active' AND superseded_by = ? LIMIT 1`)
      .get(id) as { found: number } | undefined;
    return Boolean(row);
  }

  private project(projectOverride?: string): ProjectContext {
    return this.resolver.resolve(projectOverride);
  }

  private config(project: ProjectContext): MemoryConfig {
    return resolveConfig(project.configJson, project.fileConfig);
  }

  private runMutation<T>(fn: () => T): T {
    const result = withRetry(() => this.db.transaction(fn)());
    maybeVacuum(this.db, this.random);
    return result;
  }

  private loadEntity(id: string, projectId: string): EntityRow | undefined {
    return this.db.prepare('SELECT * FROM entity WHERE id = ? AND project_id = ?').get(id, projectId) as
      | EntityRow
      | undefined;
  }

  private loadStatement(id: string, projectId: string): StatementRow | undefined {
    return this.db.prepare('SELECT * FROM statement WHERE id = ? AND project_id = ?').get(id, projectId) as
      | StatementRow
      | undefined;
  }

  private loadJournal(id: string, projectId: string): JournalRow | undefined {
    return this.db.prepare('SELECT * FROM journal_entry WHERE id = ? AND project_id = ?').get(id, projectId) as
      | JournalRow
      | undefined;
  }

  private loadRelationship(id: string, projectId: string): RelationshipRow | undefined {
    return this.db.prepare('SELECT * FROM relationship WHERE id = ? AND project_id = ?').get(id, projectId) as
      | RelationshipRow
      | undefined;
  }

  private loadRecord(table: string, id: string, projectId: string): any | undefined {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId);
  }

  private requireStatement(id: string, projectId: string): void {
    if (!this.loadStatement(id, projectId)) {
      throw new Error(`No statement found for id ${id}`);
    }
  }

  private requireJournal(id: string, projectId: string): void {
    if (!this.loadJournal(id, projectId)) {
      throw new Error(`No journal entry found for id ${id}`);
    }
  }

  private requireTarget(targetType: string, id: string, projectId: string): void {
    const table = targetType === 'entity' ? 'entity' : targetType === 'statement' ? 'statement' : 'relationship';
    if (!this.loadRecord(table, id, projectId)) {
      throw new Error(`No ${targetType} found for id ${id}`);
    }
  }

  private insertStatement(input: {
    id: string;
    projectId: string;
    entityId: string;
    claim: string;
    confidenceLevel: string;
    confidenceReason: string;
    derivationMethod: string;
    citations: string[] | undefined;
    createdAt: number;
    validFrom: number | null;
    validTo: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO statement(
          id, project_id, entity_id, edge_id, claim, confidence_level, confidence_reason,
          derivation_method, citations, created_at, valid_from, valid_to, status
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        input.id,
        input.projectId,
        input.entityId,
        input.claim,
        input.confidenceLevel,
        input.confidenceReason,
        input.derivationMethod,
        input.citations === undefined ? null : JSON.stringify(input.citations),
        input.createdAt,
        input.validFrom,
        input.validTo,
      );
  }

  private insertJournal(
    id: string,
    projectId: string,
    createdAt: number,
    commands: string[] | null,
    proven: string[] | null,
    disproven: string[] | null,
    narrative: string | null,
    isStub: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO journal_entry(id, project_id, created_at, commands, proven, disproven, narrative, is_stub, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        id,
        projectId,
        createdAt,
        commands ? JSON.stringify(commands) : null,
        proven ? JSON.stringify(proven) : null,
        disproven ? JSON.stringify(disproven) : null,
        narrative,
        isStub ? 1 : 0,
      );
  }

  private insertJournalLink(
    journalId: string,
    targetType: 'entity' | 'statement' | 'relationship' | 'journal_entry',
    targetId: string,
    role: 'created' | 'changed' | 'proven' | 'disproven' | 'deleted',
  ): void {
    this.db
      .prepare('INSERT OR IGNORE INTO journal_link(journal_id, target_type, target_id, role) VALUES (?, ?, ?, ?)')
      .run(journalId, targetType, targetId, role);
  }
}
