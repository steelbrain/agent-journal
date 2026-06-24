export const INSTRUCTIONS = `agent-journal is a project-scoped persistent memory server: a confidence-tracked knowledge base of immutable statements plus an append-only journal. The project is resolved automatically from the repo, so you do not need to pass project in normal use.

Search before acting: call memory.search at the start of a task and before assuming any project fact. As you learn things, write them as KB statements (attach atomic claims to an entity via kb.upsert_entity then kb.add_statement) and journal what you did or proved with journal.append. Capturing knowledge is part of the task, not optional cleanup.

Every statement needs confidence_level, confidence_reason, and derivation_method. verified means you observed it now (ran the command, read the source), not that you feel confident; be honest about how you learned it.

Prefer to call journal.append first and pass its id as journal_entry_id when adding or editing statements, so the claim and the work that produced it share one entry. If you omit it, the server records an auto-stub and nudges you to follow up.

Statements are immutable: use kb.edit_statement to correct a claim (it supersedes the old one) or kb.invalidate to retire stale knowledge — never expect in-place mutation. Invalid records stay readable via memory.get but are excluded from search unless you pass include_invalid.

Never write credentials, secrets, or PII into statements or journals. If poisoned content slips in, use kb.delete (not kb.invalidate) with a reason that does not repeat the secret. For the full playbook, call memory.guide.`;
