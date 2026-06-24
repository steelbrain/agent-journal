import { z } from 'zod';

export const confidenceLevel = z
  .enum(['low', 'medium', 'high', 'verified'])
  .describe(
    'How sure you are: verified = you observed it now this session (ran the command, read the source); high = strong evidence but not re-confirmed now; medium = reasonable inference from solid signals; low = weak guess readers should discount.',
  );
export const derivationMethod = z
  .enum(['direct-observation', 'command-output', 'user-assertion', 'inference', 'external-doc'])
  .describe(
    'How you learned it: direct-observation = you inspected the project/runtime; command-output = a command produced the evidence; user-assertion = the user told you; inference = you reasoned it from surrounding evidence; external-doc = an authoritative external document.',
  );
export const projectParam = z
  .string()
  .optional()
  .describe(
    'Override the auto-resolved project key. Omit in normal use — only set this to deliberately read or write another project’s memory.',
  );

export const memorySearchShape = {
  query: z.string().min(1).describe('Natural-language or keyword query. Hybrid keyword + embedding search.'),
  where: z
    .enum(['knowledge-base', 'journal', 'both'])
    .default('both')
    .describe('Scope: knowledge-base (facts), journal (activity log), or both.'),
  type: z.string().optional().describe('Restrict KB hits to entities of this type.'),
  tags: z.array(z.string()).optional().describe('Restrict KB hits to entities carrying all these tags.'),
  include_invalid: z
    .boolean()
    .default(false)
    .describe('Include retired/invalid records. Leave false unless looking for history or a live search missed.'),
  include_deleted_since: z
    .string()
    .optional()
    .describe('Duration like "30d" widening how far back invalid records remain visible (requires include_invalid).'),
  limit: z.number().int().min(1).max(100).default(20).describe('Maximum records to return (1-100).'),
  project: projectParam,
};
export const memorySearchSchema = z.object(memorySearchShape);

export const memoryGetShape = {
  id: z.string().describe('Id of an entity, statement, relationship, or journal entry to fetch in full.'),
  include_invalid_statements: z
    .boolean()
    .default(false)
    .describe('When fetching an entity, also return its retired statements.'),
  project: projectParam,
};
export const memoryGetSchema = z.object(memoryGetShape);

export const kbUpsertEntityShape = {
  id: z.string().optional().describe('Existing entity id to update. Omit to create a new entity.'),
  type: z
    .string()
    .min(1)
    .describe('Category of the subject, e.g. Service, File, Person, Config, Concept. Used to filter searches.'),
  title: z.string().min(1).describe('Human-readable name of the subject. Searched as a keyword.'),
  summary: z
    .string()
    .optional()
    .describe('Short description of the subject only. Do NOT put facts here — those belong in statements.'),
  tags: z.array(z.string()).optional().describe('Optional labels for filtering searches.'),
  project: projectParam,
};
export const kbUpsertEntitySchema = z.object(kbUpsertEntityShape);

export const kbAddStatementShape = {
  entity_id: z.string(),
  claim: z.string().min(1).describe('One atomic, self-contained fact about the entity. Keep it to a single claim.'),
  confidence_level: confidenceLevel,
  confidence_reason: z
    .string()
    .min(1)
    .describe('One honest sentence on why you chose this confidence and how you learned the fact.'),
  derivation_method: derivationMethod,
  citations: z
    .array(z.string())
    .optional()
    .describe('Optional source references backing the claim, e.g. file paths, URLs, or commit ids.'),
  valid_from: z
    .number()
    .int()
    .optional()
    .describe('Optional Unix epoch milliseconds: when the fact starts holding. Omit unless time-bounded.'),
  valid_to: z
    .number()
    .int()
    .optional()
    .describe('Optional Unix epoch milliseconds: when the fact stops holding. Omit unless time-bounded.'),
  journal_entry_id: z
    .string()
    .optional()
    .describe('Id from journal.append linking this claim to the work that produced it. If omitted, a stub is created.'),
  project: projectParam,
};
export const kbAddStatementSchema = z.object(kbAddStatementShape);

export const kbEditStatementShape = {
  statement_id: z.string().describe('Id of the active statement to correct. It is superseded by the replacement.'),
  claim: z.string().optional().describe('New claim text. Omitted fields are inherited from the original statement.'),
  confidence_level: confidenceLevel.optional(),
  confidence_reason: z.string().optional(),
  derivation_method: derivationMethod.optional(),
  citations: z
    .array(z.string())
    .optional()
    .describe('Replacement source references. Omit to keep the original statement citations.'),
  valid_from: z.number().int().optional().describe('Optional Unix epoch milliseconds: when the fact starts holding.'),
  valid_to: z.number().int().optional().describe('Optional Unix epoch milliseconds: when the fact stops holding.'),
  invalidation_note: z
    .string()
    .optional()
    .describe('Optional note recorded on the superseded statement explaining the correction.'),
  journal_entry_id: z
    .string()
    .optional()
    .describe('Id from journal.append tying this correction to your work. If omitted, a stub is created.'),
  project: projectParam,
};
export const kbEditStatementSchema = z.object(kbEditStatementShape);

export const kbInvalidateShape = {
  id: z.string().describe('Id of the active statement or entity to retire.'),
  note: z.string().min(1).describe('Required explanation of why this record is being retired.'),
  superseded_by: z
    .string()
    .optional()
    .describe('Optional id of the same-type record that replaces this one; readers are redirected to it.'),
  project: projectParam,
};
export const kbInvalidateSchema = z.object(kbInvalidateShape);

export const journalAppendShape = {
  narrative: z
    .string()
    .optional()
    .describe('Prose account of what you did and what you concluded. Indexed for search.'),
  commands: z.array(z.string()).optional().describe('Commands you ran, as you ran them.'),
  proven: z
    .array(z.string())
    .optional()
    .describe('Statement ids this work confirmed. Each is linked with role "proven".'),
  disproven: z
    .array(z.string())
    .optional()
    .describe('Statement ids this work contradicted. Each is linked with role "disproven".'),
  links: z
    .array(
      z.object({
        target_type: z.enum(['entity', 'statement', 'relationship']),
        target_id: z.string(),
        role: z.enum(['created', 'changed', 'proven', 'disproven']),
      }),
    )
    .optional()
    .describe('Explicit links from this entry to KB records it created or changed.'),
  project: projectParam,
};
export const journalAppendSchema = z.object(journalAppendShape);

export const kbDeleteShape = {
  id: z
    .string()
    .describe('Id of the record to permanently delete. Prefer kb.invalidate unless the content is poisoned.'),
  reason: z
    .string()
    .min(1)
    .describe('Required audit reason for deletion. Do not repeat the secret or sensitive value here.'),
  project: projectParam,
};
export const kbDeleteSchema = z.object(kbDeleteShape);

export const memoryRecentShape = {
  where: z
    .enum(['knowledge-base', 'journal', 'both'])
    .default('both')
    .describe('Scope: knowledge-base, journal, or both.'),
  kind: z.enum(['entity', 'statement', 'journal']).optional().describe('Restrict to one record kind.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Page size (1-100).'),
  before: z
    .number()
    .int()
    .optional()
    .describe('Unix epoch milliseconds cursor: return records created strictly before this, for paging.'),
  include_invalid: z.boolean().default(false).describe('Include retired/invalid records.'),
  project: projectParam,
};
export const memoryRecentSchema = z.object(memoryRecentShape);

export const memoryStatsShape = {
  project: projectParam,
};
export const memoryStatsSchema = z.object(memoryStatsShape);

export const emptyShape = {};
export const emptySchema = z.object(emptyShape);

export type MemorySearchInput = z.infer<typeof memorySearchSchema>;
export type MemoryGetInput = z.infer<typeof memoryGetSchema>;
export type KbUpsertEntityInput = z.infer<typeof kbUpsertEntitySchema>;
export type KbAddStatementInput = z.infer<typeof kbAddStatementSchema>;
export type KbEditStatementInput = z.infer<typeof kbEditStatementSchema>;
export type KbInvalidateInput = z.infer<typeof kbInvalidateSchema>;
export type JournalAppendInput = z.infer<typeof journalAppendSchema>;
export type KbDeleteInput = z.infer<typeof kbDeleteSchema>;
export type MemoryRecentInput = z.infer<typeof memoryRecentSchema>;
export type MemoryStatsInput = z.infer<typeof memoryStatsSchema>;
