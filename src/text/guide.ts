export const GUIDE = `agent-journal playbook

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
Use kb.invalidate for stale, wrong, or superseded knowledge. Use kb.delete only for poisoned content such as leaked secrets, credentials, PII, or garbage that must not persist on disk. Deleting a knowledge-base record writes an audit journal entry; deleting a journal entry does not. Either way deletion runs a full VACUUM.

7. Secrets and PII.
Do not store credentials, tokens, private keys, personal data, or copied sensitive output in statements or journals. If a command prints sensitive material, summarize only the safe lesson learned. If sensitive content is already stored, immediately use kb.delete with a reason that does not repeat the secret.

8. Project scoping.
Memory is project-scoped and resolved automatically, in this order: an explicit project argument on the tool call; a per-repo config file; the normalized git remote origin URL; the main worktree path (so every worktree of one repo shares the same memory); then the absolute launch cwd when outside git. Pass project only when you deliberately want to read or write another project's memory. Per-repository config lives under XDG_CONFIG_DIR, XDG_CONFIG_HOME, or ~/.config in the agent-memory directory as project_<sha256(repo-key)>.json and can pin the project or tune ranking config.`;
