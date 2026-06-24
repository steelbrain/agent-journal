import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { HashEmbeddings, TransformersEmbeddings } from '../src/domain/embeddings.js';
import { projectConfigPathForKey } from '../src/domain/paths.js';
import { normalizeOriginUrl, ProjectResolver } from '../src/domain/project.js';
import { humanizeRelative } from '../src/domain/time.js';
import { maybeVacuum } from '../src/domain/vacuum.js';
import { createMcpServer } from '../src/server.js';
import { INSTRUCTIONS } from '../src/text/instructions.js';
import { MemoryApi } from '../src/tools/api.js';
import { withRetry } from '../src/util/retry.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeApi(cwd = process.cwd(), random = () => 1) {
  const dir = tmpDir();
  vi.stubEnv('XDG_CONFIG_DIR', path.join(dir, 'config'));
  const dbFile = path.join(dir, 'memory.db');
  const db = openDb(dbFile);
  const embeddings = new HashEmbeddings();
  const resolver = new ProjectResolver(db, cwd);
  const api = new MemoryApi({ db, resolver, embeddings, dbFile, random });
  return { dir, dbFile, db, embeddings, resolver, api };
}

async function seedStatement(api: MemoryApi, overrides: Partial<Record<string, unknown>> = {}) {
  const project = typeof overrides.project === 'string' ? { project: overrides.project } : {};
  const entity = api.upsertEntity({ type: 'Service', title: 'Auth API', tags: ['auth'], ...project });
  const added = await api.addStatement({
    entity_id: entity.id,
    claim: 'Auth API runs on Node 20',
    confidence_level: 'verified',
    confidence_reason: 'verified in fixture',
    derivation_method: 'direct-observation',
    ...overrides,
  });
  return { entity, statement: added.statement, journal_entry_id: added.journal_entry_id };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('database initialization', () => {
  it('creates the v0 schema with incremental auto vacuum and WAL', () => {
    const { dbFile, db } = makeApi();

    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();

    const reopened = openDb(dbFile);
    expect(reopened.pragma('auto_vacuum', { simple: true })).toBe(2);
    expect(reopened.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(reopened.pragma('user_version', { simple: true })).toBe(1);
    reopened.close();
  });
});

describe('tool contracts', () => {
  it('registers exactly the v0 MCP tools and exposes initialize instructions', () => {
    const { api } = makeApi();
    const server = createMcpServer(api);
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(registered).sort()).toEqual(
      [
        'journal.append',
        'kb.add_statement',
        'kb.delete',
        'kb.edit_statement',
        'kb.invalidate',
        'kb.upsert_entity',
        'memory.agents_md_snippet',
        'memory.get',
        'memory.guide',
        'memory.recent',
        'memory.search',
        'memory.stats',
      ].sort(),
    );
    expect((server.server as unknown as { _options: { instructions: string } })._options.instructions).toBe(
      INSTRUCTIONS,
    );
  });

  it('enforces the statement confidence contract', async () => {
    const { api } = makeApi();
    const entity = api.upsertEntity({ type: 'Service', title: 'Auth API' });
    await expect(
      api.addStatement({
        entity_id: entity.id,
        claim: 'Auth API runs on Node 20',
        confidence_level: 'verified',
        derivation_method: 'direct-observation',
      }),
    ).rejects.toThrow(/confidence_reason/);
  });

  it('returns guide and AGENTS.md snippet text', () => {
    const { api } = makeApi();
    expect(api.guide({}).guide).toContain('confidence_level');
    expect(api.agentsMdSnippet({}).snippet).toBe(
      'This project has an `agent-journal` MCP server providing a persistent knowledge base + journal. Its usage is self-described on connect; call `memory.guide` for the full playbook.',
    );
  });
});

describe('statement lifecycle', () => {
  it('edits immutably and keeps invalid statements readable with redirects', async () => {
    const { db, api } = makeApi();
    const { statement } = await seedStatement(api);
    const edited = await api.editStatement({
      statement_id: statement.id,
      claim: 'Auth API runs on Node 22',
    });

    expect(edited.statement.id).not.toBe(statement.id);
    expect(edited.superseded).toBe(statement.id);

    const old = api.get({ id: statement.id }) as {
      kind: 'statement';
      flagged_invalid: boolean;
      redirect: { id: string };
    };
    expect(old.kind).toBe('statement');
    expect(old.flagged_invalid).toBe(true);
    expect(old.redirect.id).toBe(edited.statement.id);

    const columns = db.pragma('table_info(statement)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('updated_at');
  });

  it('search excludes invalid by default and applies tombstone windows and redirect exemptions', async () => {
    const { db, api } = makeApi();
    const { statement } = await seedStatement(api);
    await api.invalidate({ id: statement.id, note: 'stale' });

    const liveOnly = await api.search({ query: 'Node 20', where: 'knowledge-base' });
    expect(liveOnly.total_returned).toBe(0);

    const recentInvalid = await api.search({
      query: 'Node 20',
      where: 'knowledge-base',
      include_invalid: true,
      include_deleted_since: '90d',
    });
    expect(recentInvalid.total_returned).toBe(1);

    db.prepare('UPDATE statement SET invalidated_at = ? WHERE id = ?').run(Date.now() - 10 * 86_400_000, statement.id);
    const outsideWindow = await api.search({
      query: 'Node 20',
      where: 'knowledge-base',
      include_invalid: true,
      include_deleted_since: '1d',
    });
    expect(outsideWindow.total_returned).toBe(0);

    const replacement = await api.addStatement({
      entity_id: statement.entity_id,
      claim: 'Replacement mentions Node 20',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });
    db.prepare('UPDATE statement SET superseded_by = ? WHERE id = ?').run(statement.id, replacement.statement.id);
    const exempt = await api.search({
      query: 'Node 20',
      where: 'knowledge-base',
      include_invalid: true,
      include_deleted_since: '1d',
      limit: 10,
    });
    const returnedIds = exempt.entities.flatMap((group) => group.statements.map((hit) => hit.id));
    expect(returnedIds).toContain(statement.id);
  });

  it('memory.search does not bump last_accessed, while memory.get does', async () => {
    const { db, api } = makeApi();
    const { entity, statement } = await seedStatement(api);

    await api.search({ query: 'Node 20', where: 'knowledge-base' });
    expect(db.prepare('SELECT last_accessed_at FROM statement WHERE id = ?').get(statement.id)).toEqual({
      last_accessed_at: null,
    });

    api.get({ id: statement.id });
    expect(
      (
        db.prepare('SELECT last_accessed_at FROM statement WHERE id = ?').get(statement.id) as {
          last_accessed_at: number | null;
        }
      ).last_accessed_at,
    ).toEqual(expect.any(Number));
    expect(db.prepare('SELECT last_accessed_at FROM entity WHERE id = ?').get(entity.id)).toEqual({
      last_accessed_at: null,
    });

    api.get({ id: entity.id });
    expect(
      (
        db.prepare('SELECT last_accessed_at FROM entity WHERE id = ?').get(entity.id) as {
          last_accessed_at: number | null;
        }
      ).last_accessed_at,
    ).toEqual(expect.any(Number));
  });

  it('creates an auto-stub journal without explicit provenance and skips it with an explicit journal', async () => {
    const { db, api } = makeApi();
    const entity = api.upsertEntity({ type: 'Service', title: 'Auth API' });

    const first = await api.addStatement({
      entity_id: entity.id,
      claim: 'Auth API has JWT middleware',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });
    expect(first.nudge).toContain(first.journal_entry_id);
    expect(db.prepare('SELECT is_stub FROM journal_entry WHERE id = ?').get(first.journal_entry_id)).toEqual({
      is_stub: 1,
    });
    expect(
      db
        .prepare('SELECT role FROM journal_link WHERE journal_id = ? AND target_id = ?')
        .get(first.journal_entry_id, first.statement.id),
    ).toEqual({ role: 'created' });

    const journal = await api.appendJournal({ narrative: 'Verified auth fixture' });
    const second = await api.addStatement({
      entity_id: entity.id,
      claim: 'Auth API validates issuer',
      confidence_level: 'verified',
      confidence_reason: 'fixture',
      derivation_method: 'direct-observation',
      journal_entry_id: journal.id,
    });
    expect(second.nudge).toBeUndefined();
    expect(second.journal_entry_id).toBe(journal.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entry WHERE is_stub = 1').get()).toEqual({ count: 1 });
  });

  it('cascades entity invalidation to its active statements only', async () => {
    const { db, api } = makeApi();
    const { entity, statement } = await seedStatement(api);
    const second = await api.addStatement({
      entity_id: entity.id,
      claim: 'Auth API exposes /health',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });

    const other = api.upsertEntity({ type: 'Service', title: 'Billing API' });
    const otherStatement = await api.addStatement({
      entity_id: other.id,
      claim: 'Billing API runs on Node 20',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });

    const result = (await api.invalidate({ id: entity.id, note: 'service decommissioned' })) as {
      status: string;
      cascaded_statements: number;
    };

    expect(result.status).toBe('invalid');
    expect(result.cascaded_statements).toBe(2);

    const statuses = db
      .prepare('SELECT id, status, invalidation_note FROM statement WHERE entity_id = ?')
      .all(entity.id) as Array<{ id: string; status: string; invalidation_note: string | null }>;
    expect(statuses.every((row) => row.status === 'invalid')).toBe(true);
    expect(statuses.every((row) => row.invalidation_note?.includes(entity.id))).toBe(true);
    expect([statement.id, second.statement.id].sort()).toEqual(statuses.map((row) => row.id).sort());

    // Statements under unrelated entities are untouched.
    expect(db.prepare('SELECT status FROM statement WHERE id = ?').get(otherStatement.statement.id)).toEqual({
      status: 'active',
    });
  });

  it('does not re-stamp already-invalid statements when the entity is invalidated', async () => {
    const { db, api } = makeApi();
    const { entity, statement } = await seedStatement(api);
    await api.invalidate({ id: statement.id, note: 'stale claim' });

    const result = (await api.invalidate({ id: entity.id, note: 'service decommissioned' })) as {
      cascaded_statements: number;
    };

    expect(result.cascaded_statements).toBe(0);
    expect(db.prepare('SELECT invalidation_note FROM statement WHERE id = ?').get(statement.id)).toEqual({
      invalidation_note: 'stale claim',
    });
  });
});

describe('search ranking and chronology', () => {
  it('scores recency and trust according to the configured formula', async () => {
    const { db, api } = makeApi();
    const entity = api.upsertEntity({ type: 'Service', title: 'Auth API' });
    const oldLow = await api.addStatement({
      entity_id: entity.id,
      claim: 'Auth API listens on port 3000',
      confidence_level: 'low',
      confidence_reason: 'weak fixture',
      derivation_method: 'inference',
    });
    const newVerified = await api.addStatement({
      entity_id: entity.id,
      claim: 'Auth API listens on port 3000',
      confidence_level: 'verified',
      confidence_reason: 'strong fixture',
      derivation_method: 'direct-observation',
    });
    db.prepare('UPDATE statement SET created_at = ? WHERE id = ?').run(
      Date.now() - 180 * 86_400_000,
      oldLow.statement.id,
    );

    const result = await api.search({ query: 'port 3000', where: 'knowledge-base', limit: 10 });
    const hits = result.entities.flatMap((group) => group.statements);
    expect(hits[0].id).toBe(newVerified.statement.id);
    expect(hits[0].score).toBeGreaterThan(hits.find((hit) => hit.id === oldLow.statement.id)!.score);
    expect(hits[0].score).toBeCloseTo(1 + 0.3 + 0.2 * (1 + 1), 1);
  });

  it('paginates memory.recent with counts and oldest record metadata', async () => {
    const { db, api } = makeApi();
    const one = await seedStatement(api, { claim: 'first fact' });
    const two = await api.addStatement({
      entity_id: one.entity.id,
      claim: 'second fact',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });
    db.prepare('UPDATE entity SET created_at = ? WHERE id = ?').run(1000, one.entity.id);
    db.prepare('UPDATE statement SET created_at = ? WHERE id = ?').run(2000, one.statement.id);
    db.prepare('UPDATE statement SET created_at = ? WHERE id = ?').run(3000, two.statement.id);

    const page = api.recent({ where: 'knowledge-base', limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([two.statement.id, one.statement.id]);
    expect(page.next_before).toBe(2000);
    expect(page.total_remaining).toBe(1);
    expect(page.oldest_record_date).toBe(1000);

    const next = api.recent({ where: 'knowledge-base', before: page.next_before!, limit: 2 });
    expect(next.items.map((item) => item.id)).toEqual([one.entity.id]);
  });
});

describe('deletion and vacuuming', () => {
  it('hard-deletes content, removes indexes, journals the deletion, and clears inbound redirects', async () => {
    const { db, api } = makeApi();
    const first = await seedStatement(api);
    const second = await api.addStatement({
      entity_id: first.entity.id,
      claim: 'Another auth fact',
      confidence_level: 'high',
      confidence_reason: 'fixture',
      derivation_method: 'user-assertion',
    });
    db.prepare("UPDATE statement SET superseded_by = ?, invalidation_note = 'old note' WHERE id = ?").run(
      first.statement.id,
      second.statement.id,
    );

    const deleted = api.delete({ id: first.statement.id, reason: 'contained poisoned content' });
    expect(deleted.target_type).toBe('statement');
    expect(db.prepare('SELECT * FROM statement WHERE id = ?').get(first.statement.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM embedding WHERE owner_id = ?').get(first.statement.id)).toBeUndefined();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM fts_statements WHERE statement_id = ?').get(first.statement.id),
    ).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare('SELECT role FROM journal_link WHERE journal_id = ? AND target_id = ?')
        .get(deleted.journal_entry_id, first.statement.id),
    ).toEqual({ role: 'deleted' });
    const inbound = db
      .prepare('SELECT superseded_by, invalidation_note FROM statement WHERE id = ?')
      .get(second.statement.id) as {
      superseded_by: string | null;
      invalidation_note: string;
    };
    expect(inbound.superseded_by).toBeNull();
    expect(inbound.invalidation_note).toContain(`redirect target deleted ${first.statement.id}`);
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('runs sampled incremental vacuum without error', () => {
    const { db } = makeApi();
    db.exec('CREATE TABLE vacuum_fixture(data TEXT)');
    const insert = db.prepare('INSERT INTO vacuum_fixture(data) VALUES (?)');
    const big = 'x'.repeat(20_000);
    db.transaction(() => {
      for (let i = 0; i < 100; i += 1) insert.run(big);
    })();
    db.prepare('DELETE FROM vacuum_fixture').run();
    const before = db.pragma('freelist_count', { simple: true }) as number;
    maybeVacuum(db, () => 0);
    const after = db.pragma('freelist_count', { simple: true }) as number;
    expect(after).toBeLessThanOrEqual(before);
  });

  it('hard-deletes journal entries without spawning a new journal entry', async () => {
    const { db, api } = makeApi();
    const journal = await api.appendJournal({ narrative: 'Temporary journal content' });

    const deleted = api.delete({ id: journal.id, reason: 'contained poisoned content' });

    expect(deleted.target_type).toBe('journal_entry');
    expect(deleted.journal_entry_id).toBeNull();
    expect(db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(journal.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM embedding WHERE owner_id = ?').get(journal.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM fts_journal WHERE journal_id = ?').get(journal.id)).toEqual({
      count: 0,
    });
    // No replacement audit entry, and no dangling links to or from the deleted journal.
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entry').get()).toEqual({ count: 0 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM journal_link WHERE journal_id = ? OR target_id = ?')
        .get(journal.id, journal.id),
    ).toEqual({ count: 0 });
  });
});

describe('project resolution', () => {
  it('normalizes origin URLs', () => {
    expect(normalizeOriginUrl('git@github.com:Acme/Widgets.git')).toBe('github.com/Acme/Widgets');
    expect(normalizeOriginUrl('https://user:pass@GitHub.com/Acme/Widgets.git/')).toBe('github.com/Acme/Widgets');
    expect(normalizeOriginUrl('ssh://git@GitHub.com/Acme/Widgets.git')).toBe('github.com/Acme/Widgets');
  });

  it('honors override, XDG project config, and shared worktree identity', () => {
    const root = tmpDir();
    git(['init'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Test User'], root);
    git(['remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git'], root);

    const { db } = makeApi(root);
    const configPath = projectConfigPathForKey('github.com/Acme/Widgets');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ project: 'pinned', config: { w_recency: 0.1 } }));
    const resolver = new ProjectResolver(db, root);
    expect(resolver.resolve().resolutionKey).toBe('pinned');
    expect(resolver.resolve('override').resolutionKey).toBe('override');

    fs.rmSync(configPath);
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    git(['add', 'README.md'], root);
    git(['commit', '-m', 'init'], root);
    git(['remote', 'remove', 'origin'], root);
    const worktree = path.join(tmpDir(), 'wt');
    git(['worktree', 'add', worktree], root);

    const mainKey = new ProjectResolver(db, root).resolve().resolutionKey;
    const wtKey = new ProjectResolver(db, worktree).resolve().resolutionKey;
    expect(wtKey).toBe(mainKey);
    expect(mainKey).toBe(fs.realpathSync(root));
  });
});

describe('retry behavior', () => {
  it('retries SQLITE_BUSY-style failures', () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('busy') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });
});

describe('stats', () => {
  it('scopes embedding counts to the resolved project', async () => {
    const { api } = makeApi();
    await seedStatement(api, { project: 'project-a' });
    await seedStatement(api, { project: 'project-b' });

    expect(api.stats({ project: 'project-a' }).embeddings).toBe(2);
    expect(api.stats({ project: 'project-b' }).embeddings).toBe(2);
  });
});

describe('relative timestamps', () => {
  it('humanizes past, future, and near-now offsets', () => {
    const ref = 1_000_000_000_000;
    expect(humanizeRelative(ref, ref)).toBe('just now');
    expect(humanizeRelative(ref - 2 * 60_000, ref)).toBe('2 minutes ago');
    expect(humanizeRelative(ref - 60_000, ref)).toBe('1 minute ago');
    expect(humanizeRelative(ref - 3 * 3_600_000, ref)).toBe('3 hours ago');
    expect(humanizeRelative(ref - 5 * 86_400_000, ref)).toBe('5 days ago');
    expect(humanizeRelative(ref + 3 * 86_400_000, ref)).toBe('in 3 days');
  });

  it('attaches a _relative map to record outputs and search/recent results', async () => {
    const { db, api } = makeApi();
    const { entity, statement } = await seedStatement(api);
    db.prepare('UPDATE statement SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 60_000, statement.id);

    const got = api.get({ id: statement.id }) as {
      statement: { _relative: Record<string, string>; last_accessed_at: number | null };
      entity: { id: string };
    };
    expect(got.statement._relative.created_at).toBe('2 minutes ago');
    // get() bumps last_accessed_at to now, so its relative is "just now".
    expect(got.statement._relative.last_accessed_at).toBe('just now');
    // Null timestamps (valid_from, invalidated_at) are omitted from the map.
    expect(got.statement._relative).not.toHaveProperty('invalidated_at');

    const entityGet = api.get({ id: entity.id }) as { entity: { _relative: Record<string, string> } };
    expect(entityGet.entity._relative.created_at).toBeTypeOf('string');

    const search = await api.search({ query: 'Node 20', where: 'knowledge-base', limit: 10 });
    const hit = search.entities[0].statements[0];
    expect(hit._relative.created_at).toBe('2 minutes ago');
    // Absolute and relative are paired everywhere: search hits carry created_at too.
    expect(hit.created_at).toBeTypeOf('number');

    const recent = api.recent({ where: 'both', limit: 10 }) as {
      items: Array<{ _relative: Record<string, string> }>;
      _relative: Record<string, string>;
    };
    expect(recent.items[0]._relative.created_at).toBeTypeOf('string');
    expect(recent._relative.oldest_record_date).toBeTypeOf('string');
  });
});

describe('real embedding integration', () => {
  it.skipIf(!process.env.AGENT_JOURNAL_REAL_EMBEDDINGS)('loads the real model on demand', async () => {
    const embeddings = new TransformersEmbeddings();
    await embeddings.ready();
    const vec = await embeddings.embedDocument('hello');
    expect(vec.length).toBe(384);
  });
});
