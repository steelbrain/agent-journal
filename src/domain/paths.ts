import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR_NAME = 'agent-memory';

export function configRoot(): string {
  const base = process.env.XDG_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, CONFIG_DIR_NAME);
}

export function ensureConfigRoot(): string {
  const root = configRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function projectConfigPathForKey(key: string): string {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(configRoot(), `project_${hash}.json`);
}

export function modelCacheDir(): string {
  return configRoot();
}
