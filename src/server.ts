import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MemoryApi } from './tools/api.js';
import {
  emptyShape,
  journalAppendShape,
  kbAddStatementShape,
  kbDeleteShape,
  kbEditStatementShape,
  kbInvalidateShape,
  kbUpsertEntityShape,
  memoryGetShape,
  memoryRecentShape,
  memorySearchShape,
  memoryStatsShape,
} from './tools/schemas.js';
import { INSTRUCTIONS } from './text/instructions.js';

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function wrap(handler: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  return Promise.resolve()
    .then(handler)
    .then(jsonResult)
    .catch((err) => {
      console.error(err instanceof Error && err.stack ? err.stack : err);
      return {
        isError: true,
        content: [{ type: 'text', text: errorMessage(err) }],
      };
    });
}

export function createMcpServer(api: MemoryApi, version = '0.1.0'): McpServer {
  const server = new McpServer(
    { name: 'agent-journal', version },
    {
      instructions: INSTRUCTIONS,
    },
  );

  server.registerTool(
    'memory.search',
    {
      description:
        'Hybrid keyword + embedding search over the project KB and/or journal. Call this first on any task and before assuming a project fact — it is the primary way to recall memory. Returns compact scored snippets; follow up with memory.get for full records. KB hits are statements grouped under their entity. Invalid records are excluded by default; pass include_invalid only for history or after a live search misses. Read-only: does not bump last_accessed.',
      inputSchema: memorySearchShape,
    },
    (args) => wrap(() => api.search(args)),
  );

  server.registerTool(
    'memory.get',
    {
      description:
        'Fetch a full entity, statement, relationship, or journal entry by ID. Direct statement/entity reads bump last_accessed_at. Invalid statements are still returned and clearly flagged, with a redirect when superseded.',
      inputSchema: memoryGetShape,
    },
    (args) => wrap(() => api.get(args)),
  );

  server.registerTool(
    'memory.recent',
    {
      description:
        'Chronological latest-to-oldest view for situational awareness and paging. This is not relevance search; use memory.search for retrieval. Invalid records are excluded unless include_invalid is true.',
      inputSchema: memoryRecentShape,
    },
    (args) => wrap(() => api.recent(args)),
  );

  server.registerTool(
    'memory.stats',
    {
      description:
        'Return project record counts by status, embedding count, DB file size, model metadata, and freelist_count.',
      inputSchema: memoryStatsShape,
    },
    (args) => wrap(() => api.stats(args)),
  );

  server.registerTool(
    'memory.guide',
    {
      description:
        'Return the full agent-journal operating playbook: search discipline, journaling, confidence examples, immutable edits, invalidation vs deletion, and secret/PII rules.',
      inputSchema: emptyShape,
    },
    (args) => wrap(() => api.guide(args)),
  );

  server.registerTool(
    'memory.agents_md_snippet',
    {
      description:
        'Return the one-line AGENTS.md/CLAUDE.md pointer explaining that this project has agent-journal and memory.guide.',
      inputSchema: emptyShape,
    },
    (args) => wrap(() => api.agentsMdSnippet(args)),
  );

  server.registerTool(
    'kb.upsert_entity',
    {
      description:
        'Create or update a KB entity: the named subject (a service, file, person, config, concept) that statements hang from. An entity carries no facts itself — keep the summary a short description and put every actual claim in a statement via kb.add_statement. Reuse an existing entity (search first) instead of creating duplicates; pass its id to update. Updates are allowed only while active; invalid entities are read-only. Title changes re-sync statement keyword titles but do not re-embed statements in v0.',
      inputSchema: kbUpsertEntityShape,
    },
    (args) => wrap(() => api.upsertEntity(args)),
  );

  server.registerTool(
    'kb.add_statement',
    {
      description:
        'Add one immutable, atomic claim to an active entity — keep it to a single fact so a future correction can invalidate it without retiring unrelated knowledge. Requires confidence_level, confidence_reason, and derivation_method; verified means you observed it now (ran the command, read the source), not merely that you are confident. Prefer calling journal.append first and passing its id as journal_entry_id; if omitted, the server creates a stub journal entry, links it, and returns a nudge. Optional valid_from/valid_to (Unix epoch milliseconds) bound when the fact holds. Never store secrets, credentials, or PII.',
      inputSchema: kbAddStatementShape,
    },
    (args) => wrap(() => api.addStatement(args)),
  );

  server.registerTool(
    'kb.edit_statement',
    {
      description:
        'Correct a statement immutably: creates a replacement statement carrying your changes, invalidates the old active statement, and redirects the old one to the replacement (memory.get follows the redirect). Unspecified fields are inherited from the original. Use this whenever a claim, confidence, or provenance changes — do not expect in-place edits, and invalid statements cannot be edited (add a fresh statement instead). Pass journal_entry_id to tie the correction to your work, or a stub is created.',
      inputSchema: kbEditStatementShape,
    },
    (args) => wrap(() => api.editStatement(args)),
  );

  server.registerTool(
    'kb.invalidate',
    {
      description:
        'Soft-invalidate an active statement or entity with a required note explaining why, plus an optional same-type superseded_by redirect to the record that replaces it. This is the normal, preferred way to retire stale or wrong knowledge (reach for kb.delete only for secrets/PII/garbage). Invalidating an entity cascades to its active statements (count returned as cascaded_statements); relationships referencing it are left untouched. Invalid records stay readable via memory.get and searchable only when include_invalid is passed.',
      inputSchema: kbInvalidateShape,
    },
    (args) => wrap(() => api.invalidate(args)),
  );

  server.registerTool(
    'kb.delete',
    {
      description:
        'Hard-delete a record permanently and run a full VACUUM so the content cannot be recovered from disk. Deleting a knowledge-base record writes an audit journal entry; deleting a journal entry does not (the journal is the audit log itself). Use this ONLY for poisoned content — secrets, credentials, PII, or garbage that must not persist. For ordinary stale or wrong knowledge use kb.invalidate instead, which keeps history. Give a reason that does not repeat the sensitive value.',
      inputSchema: kbDeleteShape,
    },
    (args) => wrap(() => api.delete(args)),
  );

  server.registerTool(
    'journal.append',
    {
      description:
        'Append a journal entry recording what you did: a narrative, the commands you ran, and statement ids you proved or disproved. Link the entry to the KB records it created or changed via links. Capture the id this returns and pass it as journal_entry_id when adding or editing statements so the claim and its supporting work stay connected. Append-only in v0 — entries are never edited, so write a complete account each time.',
      inputSchema: journalAppendShape,
    },
    (args) => wrap(() => api.appendJournal(args)),
  );

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
