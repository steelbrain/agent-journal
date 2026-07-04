#!/usr/bin/env node

// src/index.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/db/connection.ts
import fs from "node:fs";
import path2 from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// src/db/migrations.ts
var VERSION = 2;
function runMigrations(db) {
  const current = db.pragma("user_version", { simple: true });
  if (current >= VERSION) {
    return;
  }
  db.transaction(() => {
    if (current < 1) migrateV1(db);
    if (current < 2) migrateV2(db);
    db.pragma(`user_version = ${VERSION}`);
  })();
}
function migrateV1(db) {
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
function migrateV2(db) {
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
  const vectors = db.prepare("SELECT owner_type, owner_id, embedding, project_id, status FROM mig_vec WHERE project_id IS NOT NULL").all();
  const insertVec = db.prepare("INSERT INTO vec_index(project_id, embedding, owner_type, status) VALUES (?, ?, ?, ?)");
  const remap = db.prepare("UPDATE embedding SET vec_rowid = ? WHERE owner_type = ? AND owner_id = ?");
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

// src/domain/paths.ts
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
var CONFIG_DIR_NAME = "agent-memory";
function configRoot() {
  const base = process.env.XDG_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, CONFIG_DIR_NAME);
}
function projectConfigPathForKey(key) {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(configRoot(), `project_${hash}.json`);
}
function modelCacheDir() {
  return configRoot();
}

// src/db/connection.ts
function defaultDbPath() {
  return process.env.AGENT_JOURNAL_DB ?? path2.join(configRoot(), "memory.db");
}
function openDb(file) {
  fs.mkdirSync(path2.dirname(file), { recursive: true });
  const isNew = !fs.existsSync(file);
  const db = new Database(file);
  sqliteVec.load(db);
  if (isNew) {
    db.pragma("auto_vacuum = INCREMENTAL");
  }
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  return db;
}

// src/domain/embeddings.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import path3 from "node:path";
import { env, pipeline } from "@huggingface/transformers";
var HUB_MODEL_ID = "Xenova/bge-small-en-v1.5";
var STORED_MODEL_ID = "bge-small-en-v1.5";
var DIM = 384;
var QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
var CORRUPT_MODEL_PATTERNS = [
  /protobuf parsing failed/i,
  /load model from .* failed/i,
  /failed to load model/i,
  /deserialize tensor/i,
  /invalid model/i,
  /unexpected end/i
];
function isCorruptModelError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return CORRUPT_MODEL_PATTERNS.some((pattern) => pattern.test(message));
}
var TransformersEmbeddings = class {
  loadPromise = null;
  cacheDir;
  constructor() {
    this.cacheDir = modelCacheDir();
    fs2.mkdirSync(this.cacheDir, { recursive: true });
    env.cacheDir = this.cacheDir;
    env.allowLocalModels = false;
  }
  warmup() {
    void this.embedDocument("warmup").catch((err) => {
      console.error("agent-journal embedding warmup failed:", err);
    });
  }
  async ready() {
    await this.load();
  }
  async embedQuery(text) {
    return this.embed(`${QUERY_PREFIX}${text}`);
  }
  async embedDocument(text) {
    return this.embed(text);
  }
  modelId() {
    return STORED_MODEL_ID;
  }
  dim() {
    return DIM;
  }
  contentHash(documentText) {
    return crypto2.createHash("sha256").update(`${STORED_MODEL_ID}
${documentText}`).digest("hex");
  }
  load() {
    if (!this.loadPromise) {
      const attempt = this.loadWithRecovery();
      attempt.catch(() => {
        if (this.loadPromise === attempt) this.loadPromise = null;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }
  async loadWithRecovery() {
    try {
      return await this.loadPipeline();
    } catch (err) {
      if (!isCorruptModelError(err)) throw err;
      console.error("agent-journal: cached model appears corrupt; re-downloading.", err);
      this.purgeModelCache();
      return await this.loadPipeline();
    }
  }
  loadPipeline() {
    const loadPipeline = pipeline;
    return loadPipeline("feature-extraction", HUB_MODEL_ID, { dtype: "q8" });
  }
  purgeModelCache() {
    const modelDir = path3.join(this.cacheDir, ...HUB_MODEL_ID.split("/"));
    fs2.rmSync(modelDir, { recursive: true, force: true });
  }
  async embed(text) {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: "cls", normalize: true });
    if (output.data.length !== DIM) {
      throw new Error(`Embedding model returned ${output.data.length} dimensions, expected ${DIM}`);
    }
    return output.data;
  }
};

// src/domain/project.ts
import fs3 from "node:fs";
import path4 from "node:path";
import { execFileSync } from "node:child_process";

// src/domain/ids.ts
import { ulid } from "ulid";
var PREFIX = {
  project: "proj",
  entity: "ent",
  statement: "stmt",
  relationship: "rel",
  journal: "jrnl",
  embedding: "emb"
};
var PREFIX_TO_KIND = new Map(
  Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind])
);
var newId = (kind) => `${PREFIX[kind]}_${ulid()}`;
function idKind(id) {
  const [prefix] = id.split("_", 1);
  return PREFIX_TO_KIND.get(prefix) ?? null;
}

// src/domain/time.ts
var now = () => Date.now();
var UNIT_MS = {
  s: 1e3,
  m: 60 * 1e3,
  h: 60 * 60 * 1e3,
  d: 24 * 60 * 60 * 1e3,
  y: 365 * 24 * 60 * 60 * 1e3
};
function parseDurationMs(value) {
  const match = /^(\d+)(s|m|h|d|y)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Expected e.g. 90d, 12h, 30m, 45s, or 5y.`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * UNIT_MS[unit];
}
var RELATIVE_UNITS = [
  ["year", UNIT_MS.y],
  ["month", 30 * UNIT_MS.d],
  ["week", 7 * UNIT_MS.d],
  ["day", UNIT_MS.d],
  ["hour", UNIT_MS.h],
  ["minute", UNIT_MS.m],
  ["second", UNIT_MS.s]
];
function humanizeRelative(timestamp, reference = now()) {
  const diff = reference - timestamp;
  const abs = Math.abs(diff);
  if (abs < 5 * UNIT_MS.s) return "just now";
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      const label = value === 1 ? unit : `${unit}s`;
      return diff >= 0 ? `${value} ${label} ago` : `in ${value} ${label}`;
    }
  }
  return "just now";
}
function relativeMap(record, fields, reference = now()) {
  const out = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number") out[field] = humanizeRelative(value, reference);
  }
  return out;
}

// src/domain/project.ts
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function normalizeOriginUrl(raw) {
  let value = raw.trim();
  const scpMatch = /^([^@/:]+@)?([^:]+):(.+)$/.exec(value);
  if (scpMatch && !value.includes("://")) {
    value = `${scpMatch[2]}/${scpMatch[3]}`;
  } else {
    try {
      const url = new URL(value);
      value = `${url.hostname.toLowerCase()}${url.pathname}`;
    } catch {
      value = value.replace(/^[^@/]+@/, "");
      const slash2 = value.indexOf("/");
      if (slash2 > 0) {
        value = `${value.slice(0, slash2).toLowerCase()}${value.slice(slash2)}`;
      }
    }
  }
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = value.indexOf("/");
  if (slash > 0) {
    value = `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
  }
  return value;
}
function readProjectConfigForKey(key) {
  const file = projectConfigPathForKey(key);
  if (!fs3.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs3.readFileSync(file, "utf8"));
}
function displayNameForKey(key) {
  const trimmed = key.replace(/\/+$/, "");
  return path4.basename(trimmed) || trimmed;
}
function getOrCreateProject(db, resolutionKey, fileConfig) {
  const existing = db.prepare("SELECT id, resolution_key, config FROM project WHERE resolution_key = ?").get(resolutionKey);
  if (existing) {
    return {
      id: existing.id,
      resolutionKey: existing.resolution_key,
      configJson: existing.config,
      fileConfig
    };
  }
  const id = newId("project");
  db.prepare("INSERT INTO project(id, resolution_key, display_name, config, created_at) VALUES (?, ?, ?, NULL, ?)").run(
    id,
    resolutionKey,
    displayNameForKey(resolutionKey),
    now()
  );
  return { id, resolutionKey, configJson: null, fileConfig };
}
var ProjectResolver = class {
  constructor(db, launchCwd = process.cwd()) {
    this.db = db;
    this.launchCwd = launchCwd;
  }
  db;
  launchCwd;
  launchContext = null;
  resolve(projectOverride) {
    if (projectOverride) {
      return getOrCreateProject(this.db, projectOverride);
    }
    if (!this.launchContext) {
      const resolved = this.resolveLaunchCwd();
      this.launchContext = getOrCreateProject(this.db, resolved.key, resolved.fileConfig);
    }
    return this.launchContext;
  }
  resolveLaunchCwd() {
    const key = this.resolveRepoKey();
    const projectConfig = readProjectConfigForKey(key);
    return { key: projectConfig?.project ?? key, fileConfig: projectConfig?.config };
  }
  resolveRepoKey() {
    const origin = git(["config", "--get", "remote.origin.url"], this.launchCwd);
    if (origin) {
      return normalizeOriginUrl(origin);
    }
    const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], this.launchCwd);
    if (commonDir) {
      return realpathIfPossible(path4.dirname(commonDir));
    }
    return realpathIfPossible(path4.resolve(this.launchCwd));
  }
};
function realpathIfPossible(value) {
  try {
    return fs3.realpathSync(value);
  } catch {
    return value;
  }
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools/schemas.ts
import { z } from "zod";
var confidenceLevel = z.enum(["low", "medium", "high", "verified"]).describe(
  "How sure you are: verified = you observed it now this session (ran the command, read the source); high = strong evidence but not re-confirmed now; medium = reasonable inference from solid signals; low = weak guess readers should discount."
);
var derivationMethod = z.enum(["direct-observation", "command-output", "user-assertion", "inference", "external-doc"]).describe(
  "How you learned it: direct-observation = you inspected the project/runtime; command-output = a command produced the evidence; user-assertion = the user told you; inference = you reasoned it from surrounding evidence; external-doc = an authoritative external document."
);
var projectParam = z.string().optional().describe(
  "Override the auto-resolved project key. Omit in normal use \u2014 only set this to deliberately read or write another project\u2019s memory."
);
var memorySearchShape = {
  query: z.string().min(1).describe("Natural-language or keyword query. Hybrid keyword + embedding search."),
  where: z.enum(["knowledge-base", "journal", "both"]).default("both").describe("Scope: knowledge-base (facts), journal (activity log), or both."),
  type: z.string().optional().describe("Restrict KB hits to entities of this type."),
  tags: z.array(z.string()).optional().describe("Restrict KB hits to entities carrying all these tags."),
  include_invalid: z.boolean().default(false).describe("Include retired/invalid records. Leave false unless looking for history or a live search missed."),
  include_deleted_since: z.string().optional().describe('Duration like "30d" widening how far back invalid records remain visible (requires include_invalid).'),
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum records to return (1-100)."),
  project: projectParam
};
var memorySearchSchema = z.object(memorySearchShape);
var memoryGetShape = {
  id: z.string().describe("Id of an entity, statement, relationship, or journal entry to fetch in full."),
  include_invalid_statements: z.boolean().default(false).describe("When fetching an entity, also return its retired statements."),
  project: projectParam
};
var memoryGetSchema = z.object(memoryGetShape);
var kbUpsertEntityShape = {
  id: z.string().optional().describe("Existing entity id to update. Omit to create a new entity."),
  type: z.string().min(1).describe("Category of the subject, e.g. Service, File, Person, Config, Concept. Used to filter searches."),
  title: z.string().min(1).describe("Human-readable name of the subject. Searched as a keyword."),
  summary: z.string().optional().describe("Short description of the subject only. Do NOT put facts here \u2014 those belong in statements."),
  tags: z.array(z.string()).optional().describe("Optional labels for filtering searches."),
  project: projectParam
};
var kbUpsertEntitySchema = z.object(kbUpsertEntityShape);
var kbAddStatementShape = {
  entity_id: z.string(),
  claim: z.string().min(1).describe("One atomic, self-contained fact about the entity. Keep it to a single claim."),
  confidence_level: confidenceLevel,
  confidence_reason: z.string().min(1).describe("One honest sentence on why you chose this confidence and how you learned the fact."),
  derivation_method: derivationMethod,
  citations: z.array(z.string()).optional().describe("Optional source references backing the claim, e.g. file paths, URLs, or commit ids."),
  valid_from: z.number().int().optional().describe("Optional Unix epoch milliseconds: when the fact starts holding. Omit unless time-bounded."),
  valid_to: z.number().int().optional().describe("Optional Unix epoch milliseconds: when the fact stops holding. Omit unless time-bounded."),
  journal_entry_id: z.string().optional().describe("Id from journal.append linking this claim to the work that produced it. If omitted, a stub is created."),
  project: projectParam
};
var kbAddStatementSchema = z.object(kbAddStatementShape);
var kbEditStatementShape = {
  statement_id: z.string().describe("Id of the active statement to correct. It is superseded by the replacement."),
  claim: z.string().optional().describe("New claim text. Omitted fields are inherited from the original statement."),
  confidence_level: confidenceLevel.optional(),
  confidence_reason: z.string().optional(),
  derivation_method: derivationMethod.optional(),
  citations: z.array(z.string()).optional().describe("Replacement source references. Omit to keep the original statement citations."),
  valid_from: z.number().int().optional().describe("Optional Unix epoch milliseconds: when the fact starts holding."),
  valid_to: z.number().int().optional().describe("Optional Unix epoch milliseconds: when the fact stops holding."),
  invalidation_note: z.string().optional().describe("Optional note recorded on the superseded statement explaining the correction."),
  journal_entry_id: z.string().optional().describe("Id from journal.append tying this correction to your work. If omitted, a stub is created."),
  project: projectParam
};
var kbEditStatementSchema = z.object(kbEditStatementShape);
var kbInvalidateShape = {
  id: z.string().describe("Id of the active statement or entity to retire."),
  note: z.string().min(1).describe("Required explanation of why this record is being retired."),
  superseded_by: z.string().optional().describe("Optional id of the same-type record that replaces this one; readers are redirected to it."),
  project: projectParam
};
var kbInvalidateSchema = z.object(kbInvalidateShape);
var journalAppendShape = {
  narrative: z.string().optional().describe("Prose account of what you did and what you concluded. Indexed for search."),
  commands: z.array(z.string()).optional().describe("Commands you ran, as you ran them."),
  proven: z.array(z.string()).optional().describe('Statement ids this work confirmed. Each is linked with role "proven".'),
  disproven: z.array(z.string()).optional().describe('Statement ids this work contradicted. Each is linked with role "disproven".'),
  links: z.array(
    z.object({
      target_type: z.enum(["entity", "statement", "relationship"]),
      target_id: z.string(),
      role: z.enum(["created", "changed", "proven", "disproven"])
    })
  ).optional().describe("Explicit links from this entry to KB records it created or changed."),
  project: projectParam
};
var journalAppendSchema = z.object(journalAppendShape);
var kbDeleteShape = {
  id: z.string().describe("Id of the record to permanently delete. Prefer kb.invalidate unless the content is poisoned."),
  reason: z.string().min(1).describe("Required audit reason for deletion. Do not repeat the secret or sensitive value here."),
  project: projectParam
};
var kbDeleteSchema = z.object(kbDeleteShape);
var memoryRecentShape = {
  where: z.enum(["knowledge-base", "journal", "both"]).default("both").describe("Scope: knowledge-base, journal, or both."),
  kind: z.enum(["entity", "statement", "journal"]).optional().describe("Restrict to one record kind."),
  limit: z.number().int().min(1).max(100).default(20).describe("Page size (1-100)."),
  before: z.number().int().optional().describe("Paging cursor: pass the previous page\u2019s next_before (Unix epoch milliseconds)."),
  before_id: z.string().optional().describe(
    "Paging cursor tiebreaker: pass the previous page\u2019s next_before_id together with before so records sharing a timestamp are not skipped."
  ),
  include_invalid: z.boolean().default(false).describe("Include retired/invalid records."),
  project: projectParam
};
var memoryRecentSchema = z.object(memoryRecentShape);
var memoryStatsShape = {
  project: projectParam
};
var memoryStatsSchema = z.object(memoryStatsShape);
var emptyShape = {};
var emptySchema = z.object(emptyShape);

// src/text/instructions.ts
var INSTRUCTIONS = `agent-journal is a project-scoped persistent memory server: a confidence-tracked knowledge base of immutable statements plus an append-only journal. The project is resolved automatically from the repo, so you do not need to pass project in normal use.

Search before acting: call memory.search at the start of a task and before assuming any project fact. As you learn things, write them as KB statements (attach atomic claims to an entity via kb.upsert_entity then kb.add_statement) and journal what you did or proved with journal.append. Capturing knowledge is part of the task, not optional cleanup.

Every statement needs confidence_level, confidence_reason, and derivation_method. verified means you observed it now (ran the command, read the source), not that you feel confident; be honest about how you learned it.

Prefer to call journal.append first and pass its id as journal_entry_id when adding or editing statements, so the claim and the work that produced it share one entry. If you omit it, the server records an auto-stub and nudges you to follow up.

Statements are immutable: use kb.edit_statement to correct a claim (it supersedes the old one) or kb.invalidate to retire stale knowledge \u2014 never expect in-place mutation. Invalid records stay readable via memory.get but are excluded from search unless you pass include_invalid.

Never write credentials, secrets, or PII into statements or journals. If poisoned content slips in, use kb.delete (not kb.invalidate) with a reason that does not repeat the secret. For the full playbook, call memory.guide.`;

// src/server.ts
function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
function wrap(handler) {
  return Promise.resolve().then(handler).then(jsonResult).catch((err) => {
    console.error(err instanceof Error && err.stack ? err.stack : err);
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage(err) }]
    };
  });
}
function createMcpServer(api, version = "0.1.0") {
  const server = new McpServer(
    { name: "agent-journal", version },
    {
      instructions: INSTRUCTIONS
    }
  );
  server.registerTool(
    "memory.search",
    {
      description: "Hybrid keyword + embedding search over the project KB and/or journal. Call this first on any task and before assuming a project fact \u2014 it is the primary way to recall memory. Returns compact scored snippets; follow up with memory.get for full records. KB hits are statements grouped under their entity. Invalid records are excluded by default; pass include_invalid only for history or after a live search misses. Read-only: does not bump last_accessed.",
      inputSchema: memorySearchShape
    },
    (args) => wrap(() => api.search(args))
  );
  server.registerTool(
    "memory.get",
    {
      description: "Fetch a full entity, statement, relationship, or journal entry by ID. Direct statement/entity reads bump last_accessed_at. Invalid statements are still returned and clearly flagged, with a redirect when superseded.",
      inputSchema: memoryGetShape
    },
    (args) => wrap(() => api.get(args))
  );
  server.registerTool(
    "memory.recent",
    {
      description: "Chronological latest-to-oldest view for situational awareness and paging. This is not relevance search; use memory.search for retrieval. Invalid records are excluded unless include_invalid is true. To page, pass the returned next_before and next_before_id back as before and before_id.",
      inputSchema: memoryRecentShape
    },
    (args) => wrap(() => api.recent(args))
  );
  server.registerTool(
    "memory.stats",
    {
      description: "Return project record counts by status, embedding count, DB file size, model metadata, and freelist_count.",
      inputSchema: memoryStatsShape
    },
    (args) => wrap(() => api.stats(args))
  );
  server.registerTool(
    "memory.guide",
    {
      description: "Return the full agent-journal operating playbook: search discipline, journaling, confidence examples, immutable edits, invalidation vs deletion, and secret/PII rules.",
      inputSchema: emptyShape
    },
    (args) => wrap(() => api.guide(args))
  );
  server.registerTool(
    "memory.agents_md_snippet",
    {
      description: "Return the one-line AGENTS.md/CLAUDE.md pointer explaining that this project has agent-journal and memory.guide.",
      inputSchema: emptyShape
    },
    (args) => wrap(() => api.agentsMdSnippet(args))
  );
  server.registerTool(
    "kb.upsert_entity",
    {
      description: "Create or update a KB entity: the named subject (a service, file, person, config, concept) that statements hang from. An entity carries no facts itself \u2014 keep the summary a short description and put every actual claim in a statement via kb.add_statement. Reuse an existing entity (search first) instead of creating duplicates; pass its id to update. Updates are allowed only while active; invalid entities are read-only. Title changes re-key and re-embed the entity\u2019s statements so search stays consistent.",
      inputSchema: kbUpsertEntityShape
    },
    (args) => wrap(() => api.upsertEntity(args))
  );
  server.registerTool(
    "kb.add_statement",
    {
      description: "Add one immutable, atomic claim to an active entity \u2014 keep it to a single fact so a future correction can invalidate it without retiring unrelated knowledge. Requires confidence_level, confidence_reason, and derivation_method; verified means you observed it now (ran the command, read the source), not merely that you are confident. Prefer calling journal.append first and passing its id as journal_entry_id; if omitted, the server creates a stub journal entry, links it, and returns a nudge. Optional valid_from/valid_to (Unix epoch milliseconds) bound when the fact holds. Never store secrets, credentials, or PII.",
      inputSchema: kbAddStatementShape
    },
    (args) => wrap(() => api.addStatement(args))
  );
  server.registerTool(
    "kb.edit_statement",
    {
      description: "Correct a statement immutably: creates a replacement statement carrying your changes, invalidates the old active statement, and redirects the old one to the replacement (memory.get follows the redirect). Unspecified fields are inherited from the original. Use this whenever a claim, confidence, or provenance changes \u2014 do not expect in-place edits, and invalid statements cannot be edited (add a fresh statement instead). Pass journal_entry_id to tie the correction to your work, or a stub is created.",
      inputSchema: kbEditStatementShape
    },
    (args) => wrap(() => api.editStatement(args))
  );
  server.registerTool(
    "kb.invalidate",
    {
      description: "Soft-invalidate an active statement or entity with a required note explaining why, plus an optional same-type superseded_by redirect to the record that replaces it. This is the normal, preferred way to retire stale or wrong knowledge (reach for kb.delete only for secrets/PII/garbage). Invalidating an entity cascades to its active statements (count returned as cascaded_statements); relationships referencing it are left untouched. Invalid records stay readable via memory.get and searchable only when include_invalid is passed.",
      inputSchema: kbInvalidateShape
    },
    (args) => wrap(() => api.invalidate(args))
  );
  server.registerTool(
    "kb.delete",
    {
      description: "Hard-delete a record permanently and run a full VACUUM so the content cannot be recovered from disk. Deleting an entity cascades to all of its statements and relationships. Deleting a knowledge-base record writes an audit journal entry; deleting a journal entry does not (the journal is the audit log itself). Use this ONLY for poisoned content \u2014 secrets, credentials, PII, or garbage that must not persist. For ordinary stale or wrong knowledge use kb.invalidate instead, which keeps history. Give a reason that does not repeat the sensitive value. If vacuum_completed is false in the result, the records are gone but the file vacuum was deferred because the database was busy.",
      inputSchema: kbDeleteShape
    },
    (args) => wrap(() => api.delete(args))
  );
  server.registerTool(
    "journal.append",
    {
      description: "Append a journal entry recording what you did: a narrative, the commands you ran, and statement ids you proved or disproved. Link the entry to the KB records it created or changed via links. Capture the id this returns and pass it as journal_entry_id when adding or editing statements so the claim and its supporting work stay connected. Append-only in v0 \u2014 entries are never edited, so write a complete account each time.",
      inputSchema: journalAppendShape
    },
    (args) => wrap(() => api.appendJournal(args))
  );
  return server;
}
async function connectStdio(server) {
  await server.connect(new StdioServerTransport());
}

// src/tools/api.ts
import fs4 from "node:fs";

// src/config.ts
import { z as z2 } from "zod";
var DEFAULTS = {
  rrf_k: 60,
  w_recency: 0.3,
  recency_half_life: "90d",
  w_trust: 0.2,
  trust_confidence: { verified: 1, high: 0.7, medium: 0.4, low: 0.1 },
  trust_derivation: {
    "direct-observation": 1,
    "command-output": 1,
    "external-doc": 0.7,
    "user-assertion": 0.5,
    inference: 0.2
  },
  tombstone_window: "90d",
  k_recall_fts: 100,
  k_recall_vec: 200
};
var partialConfigSchema = z2.object({
  rrf_k: z2.number().positive().optional(),
  w_recency: z2.number().nonnegative().optional(),
  recency_half_life: z2.string().optional(),
  w_trust: z2.number().nonnegative().optional(),
  trust_confidence: z2.object({
    verified: z2.number().optional(),
    high: z2.number().optional(),
    medium: z2.number().optional(),
    low: z2.number().optional()
  }).optional(),
  trust_derivation: z2.object({
    "direct-observation": z2.number().optional(),
    "command-output": z2.number().optional(),
    "external-doc": z2.number().optional(),
    "user-assertion": z2.number().optional(),
    inference: z2.number().optional()
  }).optional(),
  tombstone_window: z2.string().optional(),
  k_recall_fts: z2.number().int().positive().optional(),
  k_recall_vec: z2.number().int().positive().optional()
}).strip();
var configSchema = z2.object({
  rrf_k: z2.number().positive(),
  w_recency: z2.number().nonnegative(),
  recency_half_life: z2.string(),
  w_trust: z2.number().nonnegative(),
  trust_confidence: z2.object({
    verified: z2.number(),
    high: z2.number(),
    medium: z2.number(),
    low: z2.number()
  }),
  trust_derivation: z2.object({
    "direct-observation": z2.number(),
    "command-output": z2.number(),
    "external-doc": z2.number(),
    "user-assertion": z2.number(),
    inference: z2.number()
  }),
  tombstone_window: z2.string(),
  k_recall_fts: z2.number().int().positive(),
  k_recall_vec: z2.number().int().positive()
});
function parsePartialConfig(value) {
  return partialConfigSchema.parse(value ?? {});
}
function mergeConfig(base, next) {
  return configSchema.parse({
    ...base,
    ...next,
    trust_confidence: {
      ...base.trust_confidence,
      ...next.trust_confidence
    },
    trust_derivation: {
      ...base.trust_derivation,
      ...next.trust_derivation
    }
  });
}
function resolveConfig(projectConfigJson, fileConfig) {
  let merged = configSchema.parse(DEFAULTS);
  if (projectConfigJson) {
    merged = mergeConfig(merged, parsePartialConfig(JSON.parse(projectConfigJson)));
  }
  if (fileConfig) {
    merged = mergeConfig(merged, parsePartialConfig(fileConfig));
  }
  return merged;
}

// src/domain/fts.ts
function sanitizeFtsQuery(query) {
  const terms = query.match(/[A-Za-z0-9]+/g);
  if (!terms || terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term}"`).join(" OR ");
}
function upsertStatementFts(db, statementId, claim, entityTitle, projectId, status) {
  deleteStatementFts(db, statementId);
  db.prepare(
    "INSERT INTO fts_statements(statement_id, claim, entity_title, project_id, status) VALUES (?, ?, ?, ?, ?)"
  ).run(statementId, claim, entityTitle, projectId, status);
}
function setStatementFtsStatus(db, statementId, status) {
  db.prepare("UPDATE fts_statements SET status = ? WHERE statement_id = ?").run(status, statementId);
}
function deleteStatementFts(db, statementId) {
  db.prepare("DELETE FROM fts_statements WHERE statement_id = ?").run(statementId);
}
function upsertJournalFts(db, journalId, narrative, commands, projectId, status) {
  deleteJournalFts(db, journalId);
  db.prepare("INSERT INTO fts_journal(journal_id, narrative, commands, project_id, status) VALUES (?, ?, ?, ?, ?)").run(
    journalId,
    narrative ?? "",
    commands ? JSON.stringify(commands) : "",
    projectId,
    status
  );
}
function deleteJournalFts(db, journalId) {
  db.prepare("DELETE FROM fts_journal WHERE journal_id = ?").run(journalId);
}
function ftsSearch(db, table, query, limit, projectId, includeInvalid) {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) {
    return [];
  }
  const statusFilter = includeInvalid ? "" : "AND status = 'active'";
  if (table === "fts_statements") {
    return db.prepare(
      `SELECT statement_id AS id, bm25(fts_statements) AS bm25 FROM fts_statements
         WHERE fts_statements MATCH ? AND project_id = ? ${statusFilter}
         ORDER BY bm25 LIMIT ?`
    ).all(sanitized, projectId, limit);
  }
  return db.prepare(
    `SELECT journal_id AS id, bm25(fts_journal) AS bm25 FROM fts_journal
       WHERE fts_journal MATCH ? AND project_id = ? ${statusFilter}
       ORDER BY bm25 LIMIT ?`
  ).all(sanitized, projectId, limit);
}

// src/domain/json.ts
function jsonArray(value) {
  if (value === null || value === void 0) {
    return null;
  }
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : null;
}
function jsonStringifyArray(value) {
  return value === void 0 ? null : JSON.stringify(value);
}
function hasAllTags(stored, requested) {
  if (!requested || requested.length === 0) {
    return true;
  }
  const tags = new Set(jsonArray(stored) ?? []);
  return requested.every((tag) => tags.has(tag));
}

// src/domain/records.ts
var STATEMENT_TS_FIELDS = ["created_at", "last_accessed_at", "valid_from", "valid_to", "invalidated_at"];
var ENTITY_TS_FIELDS = ["created_at", "last_updated_at", "last_accessed_at", "invalidated_at"];
var JOURNAL_TS_FIELDS = ["created_at", "invalidated_at"];
function statementOut(row) {
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
    superseded_by: row.superseded_by
  };
  return { ...base, _relative: relativeMap(base, STATEMENT_TS_FIELDS) };
}
function entityOut(row) {
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
    superseded_by: row.superseded_by
  };
  return { ...base, _relative: relativeMap(base, ENTITY_TS_FIELDS) };
}
function journalOut(db, row) {
  const links = db.prepare(
    "SELECT target_type, target_id, role FROM journal_link WHERE journal_id = ? ORDER BY target_type, target_id, role"
  ).all(row.id);
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
    links
  };
  return { ...base, _relative: relativeMap(base, JOURNAL_TS_FIELDS) };
}
function snippet(text, length = 200) {
  const value = text ?? "";
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

// src/domain/vec.ts
function vectorJson(vec) {
  return JSON.stringify(Array.from(vec));
}
function upsertVector(db, ownerType, ownerId, vec, modelId, dim, contentHash, projectId, status) {
  const existing = db.prepare("SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?").get(ownerType, ownerId);
  if (existing) {
    db.prepare("DELETE FROM vec_index WHERE rowid = ?").run(existing.vec_rowid);
  }
  const insert = db.prepare("INSERT INTO vec_index(project_id, embedding, owner_type, status) VALUES (?, ?, ?, ?)").run(projectId, vectorJson(vec), ownerType, status);
  const vecRowid = Number(insert.lastInsertRowid);
  db.prepare(
    `INSERT INTO embedding(owner_type, owner_id, vec_rowid, model_id, dim, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET
       vec_rowid = excluded.vec_rowid,
       model_id = excluded.model_id,
       dim = excluded.dim,
       content_hash = excluded.content_hash`
  ).run(ownerType, ownerId, vecRowid, modelId, dim, contentHash);
}
function setVectorStatus(db, ownerType, ownerId, status) {
  const existing = db.prepare("SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?").get(ownerType, ownerId);
  if (existing) {
    db.prepare("UPDATE vec_index SET status = ? WHERE rowid = ?").run(status, existing.vec_rowid);
  }
}
function deleteVector(db, ownerType, ownerId) {
  const existing = db.prepare("SELECT vec_rowid FROM embedding WHERE owner_type = ? AND owner_id = ?").get(ownerType, ownerId);
  if (existing) {
    db.prepare("DELETE FROM vec_index WHERE rowid = ?").run(existing.vec_rowid);
    db.prepare("DELETE FROM embedding WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
  }
}
function knn(db, queryVec, limit, projectId, ownerType, includeInvalid) {
  const statusFilter = includeInvalid ? "" : "AND v.status = 'active'";
  const rows = db.prepare(
    `SELECT e.owner_id, v.distance
       FROM vec_index v
       JOIN embedding e ON e.vec_rowid = v.rowid
       WHERE v.embedding MATCH ? AND v.k = ? AND v.project_id = ? AND v.owner_type = ? ${statusFilter}
       ORDER BY v.distance`
  ).all(vectorJson(queryVec), limit, projectId, ownerType);
  return rows;
}

// src/domain/vacuum.ts
function maybeVacuum(db, random = Math.random) {
  if (random() < 0.1) {
    db.pragma("incremental_vacuum");
  }
}

// src/text/snippet.ts
var AGENTS_MD_SNIPPET = "This project has an `agent-journal` MCP server providing a persistent knowledge base + journal. Its usage is self-described on connect; call `memory.guide` for the full playbook.";

// src/text/guide.ts
var GUIDE = `agent-journal playbook

1. Search before acting.
Use memory.search before relying on a project fact. Search returns compact snippets and scores; call memory.get for full records. Search excludes invalid records by default so active knowledge stays prominent. Use include_invalid only when you are looking for history or when live search did not find what you need.

2. Write atomic statements.
Facts live in statements, not entity summaries. Create or update the entity that the fact is about, then add one discrete claim with kb.add_statement. Keep statements small enough that a future correction can invalidate one fact without retiring unrelated knowledge.

3. Keep the confidence contract honest.
Every statement requires confidence_level, confidence_reason, and derivation_method.
verified: you observed it now by running a command, reading authoritative output, or checking the source.
high: strong evidence, but not directly re-confirmed in this session.
medium: a reasonable inference from solid signals.
low: a guess or weak inference that readers should discount.
direct-observation: you inspected the current project or runtime yourself.
command-output: a command produced the evidence.
external-doc: an authoritative external document said it.
user-assertion: the user told you.
inference: you inferred it from surrounding evidence.

4. Journal what changed.
Use journal.append to record what you did, the commands you ran, and which statements were proven or disproven, and link the entry to the KB records it touched. Preferred workflow: call journal.append first, then pass its id as journal_entry_id to kb.add_statement or kb.edit_statement so the claim and the work that produced it share one entry. If you skip that, the server auto-creates a stub journal entry, links it to the new statement, and returns a nudge containing the stub id; follow up with journal.append to capture the real detail. Journal entries are append-only, so the stub remains as a lightweight marker and is never rewritten.

5. Edit immutably.
Statements are never edited in place. Use kb.edit_statement to create the replacement statement and invalidate the old one with a redirect, or use kb.invalidate when a statement should simply be retired. Invalid statements stay readable through memory.get and are searchable only when include_invalid is requested.

6. Invalidate vs delete.
Use kb.invalidate for stale, wrong, or superseded knowledge. Use kb.delete only for poisoned content such as leaked secrets, credentials, PII, or garbage that must not persist on disk. Deleting an entity also deletes all of its statements and relationships. Deleting a knowledge-base record writes an audit journal entry; deleting a journal entry does not. Either way deletion runs a full VACUUM.

7. Secrets and PII.
Do not store credentials, tokens, private keys, personal data, or copied sensitive output in statements or journals. If a command prints sensitive material, summarize only the safe lesson learned. If sensitive content is already stored, immediately use kb.delete with a reason that does not repeat the secret.

8. Project scoping.
Memory is project-scoped and resolved automatically, in this order: an explicit project argument on the tool call; a per-repo config file; the normalized git remote origin URL; the main worktree path (so every worktree of one repo shares the same memory); then the absolute launch cwd when outside git. Pass project only when you deliberately want to read or write another project's memory. Per-repository config lives under XDG_CONFIG_DIR, XDG_CONFIG_HOME, or ~/.config in the agent-memory directory as project_<sha256(repo-key)>.json and can pin the project or tune ranking config.`;

// src/util/retry.ts
var MAX_ATTEMPTS = 5;
function isBusyError(err) {
  return typeof err === "object" && err !== null && "code" in err && (err.code === "SQLITE_BUSY" || err.code === "SQLITE_BUSY_SNAPSHOT");
}
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
function withRetry(fn) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      const backoff = 50 * 2 ** attempt + Math.floor(Math.random() * 26);
      sleepSync(backoff);
    }
  }
  throw new Error("unreachable retry state");
}

// src/tools/api.ts
function statementDocumentText(claim, entityTitle) {
  return `${claim}
${entityTitle}`;
}
var RELATIONSHIP_TS_FIELDS = ["created_at", "last_accessed_at", "valid_from", "valid_to", "invalidated_at"];
function relationshipOut(row) {
  return { ...row, _relative: relativeMap(row, RELATIONSHIP_TS_FIELDS) };
}
function rankMap(ids) {
  const map = /* @__PURE__ */ new Map();
  ids.forEach((id, index) => {
    if (!map.has(id)) {
      map.set(id, index + 1);
    }
  });
  return map;
}
function unique(values) {
  return [...new Set(values)];
}
function placeholders(values) {
  return values.map(() => "?").join(",");
}
function scoreRecency(createdAt, timestamp, config) {
  const ageDays = Math.max(0, (timestamp - createdAt) / 864e5);
  const halfLifeDays = parseDurationMs(config.recency_half_life) / 864e5;
  return 0.5 ** (ageDays / halfLifeDays);
}
function dbTargetForKind(kind) {
  switch (kind) {
    case "entity":
      return { table: "entity", targetType: "entity" };
    case "statement":
      return { table: "statement", targetType: "statement", vectorOwner: "statement" };
    case "relationship":
      return { table: "relationship", targetType: "relationship" };
    case "journal":
      return { table: "journal_entry", targetType: "journal_entry", vectorOwner: "journal_entry" };
    default:
      return null;
  }
}
var MemoryApi = class {
  db;
  resolver;
  embeddings;
  dbFile;
  random;
  constructor(options) {
    this.db = options.db;
    this.resolver = options.resolver;
    this.embeddings = options.embeddings;
    this.dbFile = options.dbFile;
    this.random = options.random ?? Math.random;
  }
  async search(input) {
    const args = memorySearchSchema.parse(input);
    const project = this.project(args.project);
    const config = this.config(project);
    const timestamp = now();
    await this.embeddings.ready();
    const queryVec = await this.embeddings.embedQuery(args.query);
    const candidates = [];
    if (args.where === "knowledge-base" || args.where === "both") {
      candidates.push(
        ...this.searchStatements(args.query, queryVec, project, config, timestamp, {
          type: args.type,
          tags: args.tags,
          includeInvalid: args.include_invalid,
          includeDeletedSince: args.include_deleted_since
        })
      );
    }
    if (args.where === "journal" || args.where === "both") {
      candidates.push(
        ...this.searchJournal(args.query, queryVec, project, config, timestamp, {
          includeInvalid: args.include_invalid,
          includeDeletedSince: args.include_deleted_since
        })
      );
    }
    if (candidates.length > 0) {
      const min = Math.min(...candidates.map((candidate) => candidate.rawRrf));
      const max = Math.max(...candidates.map((candidate) => candidate.rawRrf));
      for (const candidate of candidates) {
        const rrfNorm = max === min ? 1 : (candidate.rawRrf - min) / (max - min);
        let trust = 0;
        if (candidate.statement) {
          trust = config.trust_confidence[candidate.statement.confidence_level] + config.trust_derivation[candidate.statement.derivation_method];
        }
        candidate.score = rrfNorm + config.w_recency * scoreRecency(candidate.created_at, timestamp, config) + config.w_trust * trust;
      }
    }
    const top = candidates.sort((a, b) => b.score - a.score || b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(0, args.limit);
    const entityGroups = /* @__PURE__ */ new Map();
    const journal = [];
    for (const hit of top) {
      if (hit.kind === "statement" && hit.statement) {
        const row = hit.statement;
        const group = entityGroups.get(row.entity_id) ?? {
          entity: { id: row.entity_id, type: row.entity_type, title: row.entity_title },
          statements: []
        };
        group.statements.push({
          kind: "statement",
          id: row.id,
          claim_snippet: snippet(row.claim),
          score: hit.score,
          confidence_level: row.confidence_level,
          derivation_method: row.derivation_method,
          status: row.status,
          created_at: row.created_at,
          _relative: { created_at: humanizeRelative(row.created_at, timestamp) }
        });
        entityGroups.set(row.entity_id, group);
      } else if (hit.kind === "journal" && hit.journal) {
        journal.push({
          kind: "journal",
          id: hit.journal.id,
          narrative_snippet: snippet(hit.journal.narrative),
          score: hit.score,
          status: hit.journal.status,
          created_at: hit.journal.created_at,
          _relative: { created_at: humanizeRelative(hit.journal.created_at, timestamp) }
        });
      }
    }
    return {
      query: args.query,
      where: args.where,
      project: project.id,
      entities: [...entityGroups.values()],
      journal,
      total_returned: top.length
    };
  }
  get(input) {
    const args = memoryGetSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);
    if (kind === "statement") {
      const row = this.loadStatement(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      withRetry(
        () => this.db.transaction(() => {
          this.db.prepare("UPDATE statement SET last_accessed_at = ? WHERE id = ?").run(now(), args.id);
        })()
      );
      const fresh = this.loadStatement(args.id, project.id);
      const entity = this.loadEntity(fresh.entity_id, project.id);
      let redirect = void 0;
      if (fresh.status === "invalid" && fresh.superseded_by) {
        const target = this.loadStatement(fresh.superseded_by, project.id);
        if (target) redirect = statementOut(target);
      }
      return {
        kind: "statement",
        statement: statementOut(fresh),
        entity: entity ? { id: entity.id, type: entity.type, title: entity.title } : null,
        ...redirect ? { redirect } : {},
        flagged_invalid: fresh.status === "invalid"
      };
    }
    if (kind === "entity") {
      const row = this.loadEntity(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      withRetry(
        () => this.db.transaction(() => {
          this.db.prepare("UPDATE entity SET last_accessed_at = ? WHERE id = ?").run(now(), args.id);
        })()
      );
      const fresh = this.loadEntity(args.id, project.id);
      const statements = this.db.prepare(
        `SELECT * FROM statement
           WHERE entity_id = ? AND project_id = ? ${args.include_invalid_statements ? "" : "AND status = 'active'"}
           ORDER BY created_at DESC, id DESC`
      ).all(args.id, project.id);
      return {
        kind: "entity",
        entity: entityOut(fresh),
        statements: statements.map(statementOut)
      };
    }
    if (kind === "journal") {
      const row = this.loadJournal(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      return { kind: "journal", entry: journalOut(this.db, row) };
    }
    if (kind === "relationship") {
      const row = this.loadRelationship(args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      return { kind: "relationship", relationship: relationshipOut(row) };
    }
    throw new Error(`No record found for id ${args.id}`);
  }
  async upsertEntity(input) {
    const args = kbUpsertEntitySchema.parse(input);
    const project = this.project(args.project);
    if (!args.id) {
      return this.runMutation(() => {
        const timestamp = now();
        const id = newId("entity");
        this.db.prepare(
          `INSERT INTO entity(id, project_id, type, title, summary, tags, created_at, last_updated_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        ).run(
          id,
          project.id,
          args.type,
          args.title,
          args.summary ?? null,
          jsonStringifyArray(args.tags),
          timestamp,
          timestamp
        );
        return entityOut(this.loadEntity(id, project.id));
      });
    }
    const entityId = args.id;
    const existing = this.loadEntity(entityId, project.id);
    if (!existing) throw new Error(`No active entity found for id ${entityId}`);
    if (existing.status !== "active") {
      throw new Error(`Entity ${entityId} is invalid and read-only`);
    }
    const titleChanged = args.title !== existing.title;
    const statements = titleChanged ? this.db.prepare("SELECT id, claim, status FROM statement WHERE entity_id = ? AND project_id = ?").all(entityId, project.id) : [];
    const reindexed = [];
    for (const statement of statements) {
      const documentText = statementDocumentText(statement.claim, args.title);
      reindexed.push({
        ...statement,
        vec: await this.embeddings.embedDocument(documentText),
        hash: this.embeddings.contentHash(documentText)
      });
    }
    return this.runMutation(() => {
      const timestamp = now();
      this.db.prepare(
        `UPDATE entity
           SET type = ?, title = ?, summary = ?, tags = ?, last_updated_at = ?
           WHERE id = ? AND project_id = ?`
      ).run(
        args.type,
        args.title,
        args.summary ?? existing.summary,
        args.tags === void 0 ? existing.tags : JSON.stringify(args.tags),
        timestamp,
        entityId,
        project.id
      );
      for (const statement of reindexed) {
        upsertStatementFts(this.db, statement.id, statement.claim, args.title, project.id, statement.status);
        upsertVector(
          this.db,
          "statement",
          statement.id,
          statement.vec,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          statement.hash,
          project.id,
          statement.status
        );
      }
      return entityOut(this.loadEntity(entityId, project.id));
    });
  }
  async addStatement(input) {
    const args = kbAddStatementSchema.parse(input);
    const project = this.project(args.project);
    const entity = this.loadEntity(args.entity_id, project.id);
    if (!entity) throw new Error(`No active entity found for id ${args.entity_id}`);
    if (entity.status !== "active") {
      throw new Error(`Entity ${args.entity_id} is invalid and read-only`);
    }
    const statementId = newId("statement");
    const statementVec = await this.embeddings.embedDocument(statementDocumentText(args.claim, entity.title));
    const statementHash = this.embeddings.contentHash(statementDocumentText(args.claim, entity.title));
    const stubJournalId = args.journal_entry_id ? null : newId("journal");
    const stubNarrative = stubJournalId ? `auto-stub for statement ${statementId}` : null;
    const stubVec = stubNarrative ? await this.embeddings.embedDocument(stubNarrative) : null;
    const stubHash = stubNarrative ? this.embeddings.contentHash(stubNarrative) : null;
    const result = this.runMutation(() => {
      const timestamp = now();
      let journalEntryId = args.journal_entry_id ?? stubJournalId;
      if (args.journal_entry_id) {
        this.requireJournal(args.journal_entry_id, project.id);
      } else {
        this.insertJournal(stubJournalId, project.id, timestamp, null, null, null, stubNarrative, true);
        upsertJournalFts(this.db, stubJournalId, stubNarrative, null, project.id, "active");
        upsertVector(
          this.db,
          "journal_entry",
          stubJournalId,
          stubVec,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          stubHash,
          project.id,
          "active"
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
        validTo: args.valid_to ?? null
      });
      upsertVector(
        this.db,
        "statement",
        statementId,
        statementVec,
        this.embeddings.modelId(),
        this.embeddings.dim(),
        statementHash,
        project.id,
        "active"
      );
      upsertStatementFts(this.db, statementId, args.claim, entity.title, project.id, "active");
      this.insertJournalLink(journalEntryId, "statement", statementId, "created");
      return {
        statement: statementOut(this.loadStatement(statementId, project.id)),
        journal_entry_id: journalEntryId,
        ...stubJournalId ? {
          nudge: `Recorded with an auto-created journal stub (${stubJournalId}). Consider journal.append with what you did and what it proves, then link it.`
        } : {}
      };
    });
    return result;
  }
  async editStatement(input) {
    const args = kbEditStatementSchema.parse(input);
    const valueFields = [
      "claim",
      "confidence_level",
      "confidence_reason",
      "derivation_method",
      "citations",
      "valid_from",
      "valid_to"
    ];
    if (!valueFields.some((field) => args[field] !== void 0)) {
      throw new Error("nothing to edit");
    }
    const project = this.project(args.project);
    const target = this.loadStatement(args.statement_id, project.id);
    if (!target) throw new Error(`No active statement found for id ${args.statement_id}`);
    if (target.status !== "active") {
      throw new Error(`Statement ${args.statement_id} is invalid and read-only`);
    }
    const entity = this.loadEntity(target.entity_id, project.id);
    if (!entity) throw new Error(`No entity found for statement ${target.id}`);
    const replacement = {
      claim: args.claim ?? target.claim,
      confidenceLevel: args.confidence_level ?? target.confidence_level,
      confidenceReason: args.confidence_reason ?? target.confidence_reason,
      derivationMethod: args.derivation_method ?? target.derivation_method,
      citations: args.citations === void 0 ? target.citations ? JSON.parse(target.citations) : void 0 : args.citations,
      validFrom: args.valid_from ?? target.valid_from,
      validTo: args.valid_to ?? target.valid_to
    };
    const newStatementId = newId("statement");
    const documentText = statementDocumentText(replacement.claim, entity.title);
    const statementVec = await this.embeddings.embedDocument(documentText);
    const statementHash = this.embeddings.contentHash(documentText);
    const stubJournalId = args.journal_entry_id ? null : newId("journal");
    const stubNarrative = stubJournalId ? `auto-stub for statement ${newStatementId}` : null;
    const stubVec = stubNarrative ? await this.embeddings.embedDocument(stubNarrative) : null;
    const stubHash = stubNarrative ? this.embeddings.contentHash(stubNarrative) : null;
    return this.runMutation(() => {
      const timestamp = now();
      const journalEntryId = args.journal_entry_id ?? stubJournalId;
      if (args.journal_entry_id) {
        this.requireJournal(args.journal_entry_id, project.id);
      } else {
        this.insertJournal(stubJournalId, project.id, timestamp, null, null, null, stubNarrative, true);
        upsertJournalFts(this.db, stubJournalId, stubNarrative, null, project.id, "active");
        upsertVector(
          this.db,
          "journal_entry",
          stubJournalId,
          stubVec,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          stubHash,
          project.id,
          "active"
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
        validTo: replacement.validTo
      });
      upsertVector(
        this.db,
        "statement",
        newStatementId,
        statementVec,
        this.embeddings.modelId(),
        this.embeddings.dim(),
        statementHash,
        project.id,
        "active"
      );
      upsertStatementFts(this.db, newStatementId, replacement.claim, entity.title, project.id, "active");
      this.db.prepare(
        `UPDATE statement
           SET status = 'invalid', invalidated_at = ?, superseded_by = ?, invalidation_note = ?
           WHERE id = ? AND project_id = ?`
      ).run(
        timestamp,
        newStatementId,
        args.invalidation_note ?? `edited -> superseded by ${newStatementId}`,
        target.id,
        project.id
      );
      setStatementFtsStatus(this.db, target.id, "invalid");
      setVectorStatus(this.db, "statement", target.id, "invalid");
      this.insertJournalLink(journalEntryId, "statement", newStatementId, "created");
      this.insertJournalLink(journalEntryId, "statement", newStatementId, "changed");
      return {
        statement: statementOut(this.loadStatement(newStatementId, project.id)),
        superseded: target.id,
        journal_entry_id: journalEntryId,
        ...stubJournalId ? {
          nudge: `Recorded with an auto-created journal stub (${stubJournalId}). Consider journal.append with what you did and what it proves, then link it.`
        } : {}
      };
    });
  }
  invalidate(input) {
    const args = kbInvalidateSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);
    const target = kind ? dbTargetForKind(kind) : null;
    if (!target || target.targetType === "journal_entry") {
      throw new Error(`No record found for id ${args.id}`);
    }
    return this.runMutation(() => {
      const row = this.loadRecord(target.table, args.id, project.id);
      if (!row) throw new Error(`No record found for id ${args.id}`);
      if (row.status !== "active") {
        throw new Error(`Record ${args.id} is invalid and read-only`);
      }
      if (args.superseded_by) {
        const supersedingKind = idKind(args.superseded_by);
        const supersedingTarget = supersedingKind ? dbTargetForKind(supersedingKind) : null;
        if (!supersedingTarget || supersedingTarget.table !== target.table) {
          throw new Error("superseded_by must reference the same record type");
        }
        if (!this.loadRecord(target.table, args.superseded_by, project.id)) {
          throw new Error(`No record found for superseded_by ${args.superseded_by}`);
        }
      }
      const invalidatedAt = now();
      this.db.prepare(
        `UPDATE ${target.table}
           SET status = 'invalid', invalidated_at = ?, invalidation_note = ?, superseded_by = ?
           WHERE id = ? AND project_id = ?`
      ).run(invalidatedAt, args.note, args.superseded_by ?? null, args.id, project.id);
      if (target.table === "statement") {
        setStatementFtsStatus(this.db, args.id, "invalid");
        setVectorStatus(this.db, "statement", args.id, "invalid");
        return statementOut(this.loadStatement(args.id, project.id));
      }
      if (target.table === "entity") {
        const cascadeIds = this.db.prepare("SELECT id FROM statement WHERE entity_id = ? AND project_id = ? AND status = 'active'").all(args.id, project.id).map((row2) => row2.id);
        this.db.prepare(
          `UPDATE statement
             SET status = 'invalid', invalidated_at = ?, invalidation_note = ?
             WHERE entity_id = ? AND project_id = ? AND status = 'active'`
        ).run(invalidatedAt, `Parent entity ${args.id} retired: ${args.note}`, args.id, project.id);
        for (const statementId of cascadeIds) {
          setStatementFtsStatus(this.db, statementId, "invalid");
          setVectorStatus(this.db, "statement", statementId, "invalid");
        }
        return { ...entityOut(this.loadEntity(args.id, project.id)), cascaded_statements: cascadeIds.length };
      }
      return relationshipOut(this.loadRelationship(args.id, project.id));
    });
  }
  async appendJournal(input) {
    const args = journalAppendSchema.parse(input);
    if (args.narrative === void 0 && args.commands === void 0 && args.proven === void 0 && args.disproven === void 0 && args.links === void 0) {
      throw new Error("journal.append requires at least one of narrative, commands, proven, disproven, or links");
    }
    const project = this.project(args.project);
    const journalId = newId("journal");
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
        false
      );
      for (const link of args.links ?? []) {
        this.insertJournalLink(journalId, link.target_type, link.target_id, link.role);
      }
      for (const statementId of args.proven ?? []) {
        this.insertJournalLink(journalId, "statement", statementId, "proven");
      }
      for (const statementId of args.disproven ?? []) {
        this.insertJournalLink(journalId, "statement", statementId, "disproven");
      }
      if (shouldIndex) {
        upsertJournalFts(this.db, journalId, narrative, args.commands ?? null, project.id, "active");
        upsertVector(
          this.db,
          "journal_entry",
          journalId,
          vec,
          this.embeddings.modelId(),
          this.embeddings.dim(),
          hash,
          project.id,
          "active"
        );
      }
      return journalOut(this.db, this.loadJournal(journalId, project.id));
    });
  }
  delete(input) {
    const args = kbDeleteSchema.parse(input);
    const project = this.project(args.project);
    const kind = idKind(args.id);
    const target = kind ? dbTargetForKind(kind) : null;
    if (!target) {
      throw new Error(`No record found for id ${args.id}`);
    }
    const result = withRetry(
      () => this.db.transaction(() => {
        const row = this.loadRecord(target.table, args.id, project.id);
        if (!row) throw new Error(`No record found for id ${args.id}`);
        const isJournalTarget = target.table === "journal_entry";
        const timestamp = now();
        const cascadeStatements = target.table === "entity" ? this.db.prepare("SELECT id FROM statement WHERE entity_id = ? AND project_id = ?").all(args.id, project.id).map((statement) => statement.id) : [];
        const cascadeRelationships = target.table === "entity" ? this.db.prepare("SELECT id FROM relationship WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)").all(project.id, args.id, args.id).map((relationship) => relationship.id) : [];
        let journalId = null;
        if (!isJournalTarget) {
          journalId = newId("journal");
          const cascadeSuffix = cascadeStatements.length > 0 || cascadeRelationships.length > 0 ? ` (cascaded ${cascadeStatements.length} statements, ${cascadeRelationships.length} relationships)` : "";
          const narrative = `DELETED ${target.targetType} ${args.id}${cascadeSuffix}: ${args.reason}`;
          this.insertJournal(journalId, project.id, timestamp, null, null, null, narrative, false);
          upsertJournalFts(this.db, journalId, narrative, null, project.id, "active");
          this.insertJournalLink(journalId, target.targetType, args.id, "deleted");
          for (const statementId of cascadeStatements) {
            this.insertJournalLink(journalId, "statement", statementId, "deleted");
          }
          for (const relationshipId of cascadeRelationships) {
            this.insertJournalLink(journalId, "relationship", relationshipId, "deleted");
          }
        }
        if (isJournalTarget) {
          this.db.prepare("UPDATE journal_entry SET superseded_by = NULL WHERE superseded_by = ? AND project_id = ?").run(args.id, project.id);
          this.db.prepare("DELETE FROM journal_link WHERE (target_type = ? AND target_id = ?) OR journal_id = ?").run(target.targetType, args.id, args.id);
          deleteVector(this.db, "journal_entry", args.id);
          deleteJournalFts(this.db, args.id);
          this.db.prepare("DELETE FROM journal_entry WHERE id = ? AND project_id = ?").run(args.id, project.id);
          return { deleted: args.id, target_type: target.targetType, journal_entry_id: null };
        }
        this.clearInboundRedirects(target.table, args.id, project.id);
        this.dropNonAuditLinks(target.targetType, args.id, journalId);
        for (const statementId of cascadeStatements) {
          this.clearInboundRedirects("statement", statementId, project.id);
          this.dropNonAuditLinks("statement", statementId, journalId);
          deleteVector(this.db, "statement", statementId);
          deleteStatementFts(this.db, statementId);
        }
        for (const relationshipId of cascadeRelationships) {
          this.clearInboundRedirects("relationship", relationshipId, project.id);
          this.dropNonAuditLinks("relationship", relationshipId, journalId);
        }
        if (target.vectorOwner) {
          deleteVector(this.db, target.vectorOwner, args.id);
        }
        if (target.table === "statement") {
          deleteStatementFts(this.db, args.id);
        }
        if (target.table === "entity") {
          this.db.prepare("DELETE FROM statement WHERE entity_id = ? AND project_id = ?").run(args.id, project.id);
          this.db.prepare("DELETE FROM relationship WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)").run(project.id, args.id, args.id);
        }
        this.db.prepare(`DELETE FROM ${target.table} WHERE id = ? AND project_id = ?`).run(args.id, project.id);
        return {
          deleted: args.id,
          target_type: target.targetType,
          journal_entry_id: journalId,
          ...target.table === "entity" ? { cascaded_statements: cascadeStatements.length, cascaded_relationships: cascadeRelationships.length } : {}
        };
      })()
    );
    let vacuumCompleted = true;
    try {
      withRetry(() => {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        this.db.exec("VACUUM");
      });
    } catch (err) {
      vacuumCompleted = false;
      console.error("agent-journal: post-delete vacuum failed:", err);
    }
    return {
      ...result,
      vacuum_completed: vacuumCompleted,
      ...vacuumCompleted ? {} : {
        nudge: "The records are deleted, but the database was busy so the file vacuum could not run; deleted content may remain in free pages until the next vacuum."
      }
    };
  }
  clearInboundRedirects(table, deletedId, projectId) {
    this.db.prepare(
      `UPDATE ${table}
         SET superseded_by = NULL,
             invalidation_note = COALESCE(invalidation_note, '') || ?
         WHERE superseded_by = ? AND project_id = ?`
    ).run(` [redirect target deleted ${deletedId}]`, deletedId, projectId);
  }
  dropNonAuditLinks(targetType, targetId, auditJournalId) {
    this.db.prepare(
      "DELETE FROM journal_link WHERE target_type = ? AND target_id = ? AND NOT (journal_id = ? AND role = 'deleted')"
    ).run(targetType, targetId, auditJournalId);
  }
  recent(input) {
    const args = memoryRecentSchema.parse(input);
    const project = this.project(args.project);
    const includeKb = args.where === "knowledge-base" || args.where === "both";
    const includeJournal = args.where === "journal" || args.where === "both";
    const sources = [];
    if (includeKb && (!args.kind || args.kind === "entity")) {
      sources.push({ kind: "entity", table: "entity", snippetExpr: "title" });
    }
    if (includeKb && (!args.kind || args.kind === "statement")) {
      sources.push({ kind: "statement", table: "statement", snippetExpr: "claim" });
    }
    if (includeJournal && (!args.kind || args.kind === "journal")) {
      sources.push({ kind: "journal", table: "journal_entry", snippetExpr: "COALESCE(narrative, commands, '')" });
    }
    const statusSql = args.include_invalid ? "" : "AND status = 'active'";
    let cursorSql = "";
    let cursorParams = [];
    if (args.before !== void 0 && args.before_id !== void 0) {
      cursorSql = "AND (created_at < ? OR (created_at = ? AND id < ?))";
      cursorParams = [args.before, args.before, args.before_id];
    } else if (args.before !== void 0) {
      cursorSql = "AND created_at < ?";
      cursorParams = [args.before];
    }
    const rows = [];
    for (const source of sources) {
      rows.push(
        ...this.db.prepare(
          `SELECT '${source.kind}' AS kind, id, created_at, ${source.snippetExpr} AS title_or_snippet
             FROM ${source.table}
             WHERE project_id = ? ${statusSql} ${cursorSql}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
        ).all(project.id, ...cursorParams, args.limit)
      );
    }
    const reference = now();
    const page = rows.map((row) => ({
      ...row,
      title_or_snippet: snippet(row.title_or_snippet),
      _relative: { created_at: humanizeRelative(row.created_at, reference) }
    })).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, args.limit);
    const last = page.at(-1);
    let totalRemaining = 0;
    let oldest = null;
    for (const source of sources) {
      if (last) {
        totalRemaining += this.db.prepare(
          `SELECT COUNT(*) AS count FROM ${source.table}
               WHERE project_id = ? ${statusSql} AND (created_at < ? OR (created_at = ? AND id < ?))`
        ).get(project.id, last.created_at, last.created_at, last.id).count;
      }
      const min = this.db.prepare(
        `SELECT MIN(created_at) AS min FROM ${source.table}
             WHERE project_id = ? ${statusSql} ${cursorSql}`
      ).get(project.id, ...cursorParams).min;
      if (min !== null && (oldest === null || min < oldest)) {
        oldest = min;
      }
    }
    const nextBefore = totalRemaining > 0 && last ? last.created_at : null;
    const nextBeforeId = totalRemaining > 0 && last ? last.id : null;
    return {
      items: page,
      next_before: nextBefore,
      next_before_id: nextBeforeId,
      total_remaining: totalRemaining,
      oldest_record_date: oldest,
      _relative: relativeMap(
        { next_before: nextBefore, oldest_record_date: oldest },
        ["next_before", "oldest_record_date"],
        reference
      )
    };
  }
  stats(input) {
    const args = memoryStatsSchema.parse(input);
    const project = this.project(args.project);
    const countByStatus = (table) => this.db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} WHERE project_id = ? GROUP BY status`).all(project.id);
    return {
      project: project.id,
      entities: countByStatus("entity"),
      statements: countByStatus("statement"),
      journal: countByStatus("journal_entry"),
      embeddings: this.db.prepare(
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
             )`
      ).get(project.id, project.id).count,
      db_file_size: fs4.existsSync(this.dbFile) ? fs4.statSync(this.dbFile).size : 0,
      model_id: this.embeddings.modelId(),
      dim: this.embeddings.dim(),
      freelist_count: this.db.pragma("freelist_count", { simple: true })
    };
  }
  guide(input) {
    emptySchema.parse(input);
    return { guide: GUIDE };
  }
  agentsMdSnippet(input) {
    emptySchema.parse(input);
    return { snippet: AGENTS_MD_SNIPPET };
  }
  searchStatements(query, queryVec, project, config, timestamp, filters) {
    const ftsIds = ftsSearch(
      this.db,
      "fts_statements",
      query,
      config.k_recall_fts,
      project.id,
      filters.includeInvalid
    ).map((row) => row.id);
    const vecIds = knn(this.db, queryVec, config.k_recall_vec, project.id, "statement", filters.includeInvalid).map(
      (row) => row.owner_id
    );
    const ids = unique([...ftsIds, ...vecIds]);
    if (ids.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT s.*, e.type AS entity_type, e.title AS entity_title, e.tags AS entity_tags
         FROM statement s
         JOIN entity e ON e.id = s.entity_id
         WHERE s.id IN (${placeholders(ids)})`
    ).all(...ids);
    const ftsRanks = rankMap(ftsIds);
    const vecRanks = rankMap(vecIds);
    return rows.filter((row) => row.project_id === project.id).filter((row) => !filters.type || row.entity_type === filters.type).filter((row) => hasAllTags(row.entity_tags, filters.tags)).filter(
      (row) => this.visibleByStatus(
        "statement",
        row.id,
        row.status,
        row.invalidated_at,
        filters.includeInvalid,
        filters.includeDeletedSince,
        config,
        timestamp
      )
    ).map((row) => {
      const rawRrf = (ftsRanks.has(row.id) ? 1 / (config.rrf_k + ftsRanks.get(row.id)) : 0) + (vecRanks.has(row.id) ? 1 / (config.rrf_k + vecRanks.get(row.id)) : 0);
      return {
        kind: "statement",
        id: row.id,
        created_at: row.created_at,
        status: row.status,
        rawRrf,
        score: 0,
        statement: row
      };
    });
  }
  searchJournal(query, queryVec, project, config, timestamp, filters) {
    const ftsIds = ftsSearch(
      this.db,
      "fts_journal",
      query,
      config.k_recall_fts,
      project.id,
      filters.includeInvalid
    ).map((row) => row.id);
    const vecIds = knn(this.db, queryVec, config.k_recall_vec, project.id, "journal_entry", filters.includeInvalid).map(
      (row) => row.owner_id
    );
    const ids = unique([...ftsIds, ...vecIds]);
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM journal_entry WHERE id IN (${placeholders(ids)})`).all(...ids);
    const ftsRanks = rankMap(ftsIds);
    const vecRanks = rankMap(vecIds);
    return rows.filter((row) => row.project_id === project.id).filter(
      (row) => this.visibleByStatus(
        "journal_entry",
        row.id,
        row.status,
        row.invalidated_at,
        filters.includeInvalid,
        filters.includeDeletedSince,
        config,
        timestamp
      )
    ).map((row) => {
      const rawRrf = (ftsRanks.has(row.id) ? 1 / (config.rrf_k + ftsRanks.get(row.id)) : 0) + (vecRanks.has(row.id) ? 1 / (config.rrf_k + vecRanks.get(row.id)) : 0);
      return {
        kind: "journal",
        id: row.id,
        created_at: row.created_at,
        status: row.status,
        rawRrf,
        score: 0,
        journal: row
      };
    });
  }
  visibleByStatus(table, id, status, invalidatedAt, includeInvalid, includeDeletedSince, config, timestamp) {
    if (status === "active") return true;
    if (!includeInvalid) return false;
    const window = parseDurationMs(includeDeletedSince ?? config.tombstone_window);
    if (invalidatedAt !== null && invalidatedAt >= timestamp - window) {
      return true;
    }
    return this.hasLiveRedirectTo(table, id);
  }
  hasLiveRedirectTo(table, id) {
    const row = this.db.prepare(`SELECT 1 AS found FROM ${table} WHERE status = 'active' AND superseded_by = ? LIMIT 1`).get(id);
    return Boolean(row);
  }
  project(projectOverride) {
    return this.resolver.resolve(projectOverride);
  }
  config(project) {
    return resolveConfig(project.configJson, project.fileConfig);
  }
  runMutation(fn) {
    const result = withRetry(() => this.db.transaction(fn)());
    maybeVacuum(this.db, this.random);
    return result;
  }
  loadEntity(id, projectId) {
    return this.db.prepare("SELECT * FROM entity WHERE id = ? AND project_id = ?").get(id, projectId);
  }
  loadStatement(id, projectId) {
    return this.db.prepare("SELECT * FROM statement WHERE id = ? AND project_id = ?").get(id, projectId);
  }
  loadJournal(id, projectId) {
    return this.db.prepare("SELECT * FROM journal_entry WHERE id = ? AND project_id = ?").get(id, projectId);
  }
  loadRelationship(id, projectId) {
    return this.db.prepare("SELECT * FROM relationship WHERE id = ? AND project_id = ?").get(id, projectId);
  }
  loadRecord(table, id, projectId) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId);
  }
  requireStatement(id, projectId) {
    if (!this.loadStatement(id, projectId)) {
      throw new Error(`No statement found for id ${id}`);
    }
  }
  requireJournal(id, projectId) {
    if (!this.loadJournal(id, projectId)) {
      throw new Error(`No journal entry found for id ${id}`);
    }
  }
  requireTarget(targetType, id, projectId) {
    const table = targetType === "entity" ? "entity" : targetType === "statement" ? "statement" : "relationship";
    if (!this.loadRecord(table, id, projectId)) {
      throw new Error(`No ${targetType} found for id ${id}`);
    }
  }
  insertStatement(input) {
    this.db.prepare(
      `INSERT INTO statement(
          id, project_id, entity_id, edge_id, claim, confidence_level, confidence_reason,
          derivation_method, citations, created_at, valid_from, valid_to, status
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).run(
      input.id,
      input.projectId,
      input.entityId,
      input.claim,
      input.confidenceLevel,
      input.confidenceReason,
      input.derivationMethod,
      input.citations === void 0 ? null : JSON.stringify(input.citations),
      input.createdAt,
      input.validFrom,
      input.validTo
    );
  }
  insertJournal(id, projectId, createdAt, commands, proven, disproven, narrative, isStub) {
    this.db.prepare(
      `INSERT INTO journal_entry(id, project_id, created_at, commands, proven, disproven, narrative, is_stub, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).run(
      id,
      projectId,
      createdAt,
      commands ? JSON.stringify(commands) : null,
      proven ? JSON.stringify(proven) : null,
      disproven ? JSON.stringify(disproven) : null,
      narrative,
      isStub ? 1 : 0
    );
  }
  insertJournalLink(journalId, targetType, targetId, role) {
    this.db.prepare("INSERT OR IGNORE INTO journal_link(journal_id, target_type, target_id, role) VALUES (?, ?, ?, ?)").run(journalId, targetType, targetId, role);
  }
};

// src/index.ts
function readVersion() {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function helpText(version) {
  return `agent-journal v${version}

A local, project-scoped MCP server that gives coding agents a persistent
knowledge base and journal. It is meant to be launched by an agent with the
--mcp flag, not run directly in a terminal.

Add it to Claude Code:

  claude mcp add agent-journal -- npx -y agent-journal --mcp

Add it to Codex:

  codex mcp add agent-journal -- npx -y agent-journal --mcp

Or add this server entry to your client's MCP config file (commonly .mcp.json):

  {
    "mcpServers": {
      "agent-journal": {
        "command": "npx",
        "args": ["-y", "agent-journal", "--mcp"]
      }
    }
  }

Options:
  --mcp            Run as an MCP server
  -h, --help       Show this help text
  -v, --version    Print the version

Environment:
  AGENT_JOURNAL_DB   Override the database path (defaults to memory.db under the
                     app config directory)

Docs: https://github.com/steelbrain/agent-journal#readme`;
}
async function serve(version) {
  const dbFile = defaultDbPath();
  const db = openDb(dbFile);
  const resolver = new ProjectResolver(db, process.cwd());
  resolver.resolve();
  const embeddings = new TransformersEmbeddings();
  const api = new MemoryApi({ db, resolver, embeddings, dbFile });
  const server = createMcpServer(api, version);
  embeddings.warmup();
  await connectStdio(server);
}
async function main() {
  const version = readVersion();
  const args = process.argv.slice(2);
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`${version}
`);
    return;
  }
  if (args.includes("--mcp")) {
    await serve(version);
    return;
  }
  process.stdout.write(`${helpText(version)}
`);
}
main().catch((err) => {
  console.error(err instanceof Error && err.stack ? err.stack : err);
  process.exitCode = 1;
});
