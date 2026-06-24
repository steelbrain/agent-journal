import { z } from 'zod';

export const DEFAULTS = {
  rrf_k: 60,
  w_recency: 0.3,
  recency_half_life: '90d',
  w_trust: 0.2,
  trust_confidence: { verified: 1.0, high: 0.7, medium: 0.4, low: 0.1 },
  trust_derivation: {
    'direct-observation': 1.0,
    'command-output': 1.0,
    'external-doc': 0.7,
    'user-assertion': 0.5,
    inference: 0.2,
  },
  tombstone_window: '90d',
  k_recall_fts: 100,
  k_recall_vec: 200,
} as const;

const partialConfigSchema = z
  .object({
    rrf_k: z.number().positive().optional(),
    w_recency: z.number().nonnegative().optional(),
    recency_half_life: z.string().optional(),
    w_trust: z.number().nonnegative().optional(),
    trust_confidence: z
      .object({
        verified: z.number().optional(),
        high: z.number().optional(),
        medium: z.number().optional(),
        low: z.number().optional(),
      })
      .optional(),
    trust_derivation: z
      .object({
        'direct-observation': z.number().optional(),
        'command-output': z.number().optional(),
        'external-doc': z.number().optional(),
        'user-assertion': z.number().optional(),
        inference: z.number().optional(),
      })
      .optional(),
    tombstone_window: z.string().optional(),
    k_recall_fts: z.number().int().positive().optional(),
    k_recall_vec: z.number().int().positive().optional(),
  })
  .strip();

const configSchema = z.object({
  rrf_k: z.number().positive(),
  w_recency: z.number().nonnegative(),
  recency_half_life: z.string(),
  w_trust: z.number().nonnegative(),
  trust_confidence: z.object({
    verified: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
  }),
  trust_derivation: z.object({
    'direct-observation': z.number(),
    'command-output': z.number(),
    'external-doc': z.number(),
    'user-assertion': z.number(),
    inference: z.number(),
  }),
  tombstone_window: z.string(),
  k_recall_fts: z.number().int().positive(),
  k_recall_vec: z.number().int().positive(),
});

export type MemoryConfig = z.infer<typeof configSchema>;
export type PartialMemoryConfig = z.infer<typeof partialConfigSchema>;

function parsePartialConfig(value: unknown): PartialMemoryConfig {
  return partialConfigSchema.parse(value ?? {});
}

function mergeConfig(base: MemoryConfig, next: PartialMemoryConfig): MemoryConfig {
  return configSchema.parse({
    ...base,
    ...next,
    trust_confidence: {
      ...base.trust_confidence,
      ...next.trust_confidence,
    },
    trust_derivation: {
      ...base.trust_derivation,
      ...next.trust_derivation,
    },
  });
}

export function resolveConfig(projectConfigJson?: string | null, fileConfig?: unknown): MemoryConfig {
  let merged = configSchema.parse(DEFAULTS);

  if (projectConfigJson) {
    merged = mergeConfig(merged, parsePartialConfig(JSON.parse(projectConfigJson)));
  }

  if (fileConfig) {
    merged = mergeConfig(merged, parsePartialConfig(fileConfig));
  }

  return merged;
}
