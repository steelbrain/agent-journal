import { ulid } from 'ulid';

const PREFIX = {
  project: 'proj',
  entity: 'ent',
  statement: 'stmt',
  relationship: 'rel',
  journal: 'jrnl',
  embedding: 'emb',
} as const;

export type IdKind = keyof typeof PREFIX;

const PREFIX_TO_KIND = new Map<string, IdKind>(
  Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind as IdKind]),
);

export const newId = (kind: IdKind) => `${PREFIX[kind]}_${ulid()}`;

export function idKind(id: string): IdKind | null {
  const [prefix] = id.split('_', 1);
  return PREFIX_TO_KIND.get(prefix) ?? null;
}
