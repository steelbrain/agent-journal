import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { newId } from './ids.js';
import { projectConfigPathForKey } from './paths.js';
import { now } from './time.js';

export type AgentJournalProjectConfig = {
  project?: string;
  config?: unknown;
  group?: string[];
};

export type ProjectContext = {
  id: string;
  resolutionKey: string;
  configJson: string | null;
  fileConfig?: unknown;
};

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function normalizeOriginUrl(raw: string): string {
  let value = raw.trim();

  const scpMatch = /^([^@/:]+@)?([^:]+):(.+)$/.exec(value);
  if (scpMatch && !value.includes('://')) {
    value = `${scpMatch[2]}/${scpMatch[3]}`;
  } else {
    try {
      const url = new URL(value);
      value = `${url.hostname.toLowerCase()}${url.pathname}`;
    } catch {
      value = value.replace(/^[^@/]+@/, '');
      const slash = value.indexOf('/');
      if (slash > 0) {
        value = `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
      }
    }
  }

  value = value.replace(/\/+$/, '').replace(/\.git$/, '');
  const slash = value.indexOf('/');
  if (slash > 0) {
    value = `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
  }
  return value;
}

function readProjectConfigForKey(key: string): AgentJournalProjectConfig | null {
  const file = projectConfigPathForKey(key);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as AgentJournalProjectConfig;
}

function displayNameForKey(key: string): string {
  const trimmed = key.replace(/\/+$/, '');
  return path.basename(trimmed) || trimmed;
}

export function getOrCreateProject(db: Database.Database, resolutionKey: string, fileConfig?: unknown): ProjectContext {
  const existing = db
    .prepare('SELECT id, resolution_key, config FROM project WHERE resolution_key = ?')
    .get(resolutionKey) as { id: string; resolution_key: string; config: string | null } | undefined;

  if (existing) {
    return {
      id: existing.id,
      resolutionKey: existing.resolution_key,
      configJson: existing.config,
      fileConfig,
    };
  }

  const id = newId('project');
  db.prepare('INSERT INTO project(id, resolution_key, display_name, config, created_at) VALUES (?, ?, ?, NULL, ?)').run(
    id,
    resolutionKey,
    displayNameForKey(resolutionKey),
    now(),
  );
  return { id, resolutionKey, configJson: null, fileConfig };
}

export class ProjectResolver {
  private launchContext: ProjectContext | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly launchCwd = process.cwd(),
  ) {}

  resolve(projectOverride?: string): ProjectContext {
    if (projectOverride) {
      return getOrCreateProject(this.db, projectOverride);
    }

    if (!this.launchContext) {
      const resolved = this.resolveLaunchCwd();
      this.launchContext = getOrCreateProject(this.db, resolved.key, resolved.fileConfig);
    }
    return this.launchContext;
  }

  private resolveLaunchCwd(): { key: string; fileConfig?: unknown } {
    const key = this.resolveRepoKey();
    const projectConfig = readProjectConfigForKey(key);
    return { key: projectConfig?.project ?? key, fileConfig: projectConfig?.config };
  }

  private resolveRepoKey(): string {
    const origin = git(['config', '--get', 'remote.origin.url'], this.launchCwd);
    if (origin) {
      return normalizeOriginUrl(origin);
    }

    const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], this.launchCwd);
    if (commonDir) {
      return realpathIfPossible(path.dirname(commonDir));
    }

    return realpathIfPossible(path.resolve(this.launchCwd));
  }
}

function realpathIfPossible(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}
