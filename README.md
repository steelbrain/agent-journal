# agent-journal

Persistent knowledge base & journal for coding agents.

`agent-journal` is an MCP server that gives coding agents a local,
project-scoped knowledge base and journal. Knowledge is stored as immutable,
confidence-tracked statements attached to entities; journal entries record what
was done and what was proven.

## Setup

First run may download native/prebuilt dependencies and the embedding model.

## Claude Code

```sh
claude mcp add agent-journal -- npx -y agent-journal --mcp
```

## Codex

```sh
codex mcp add agent-journal -- npx -y agent-journal --mcp
```

## MCP config file

Most MCP clients read a JSON config (commonly `.mcp.json`). The server entry is
the same regardless of client:

```json
{
  "mcpServers": {
    "agent-journal": {
      "command": "npx",
      "args": ["-y", "agent-journal", "--mcp"]
    }
  }
}
```

## AGENTS.md / CLAUDE.md

Add this line to the project instructions file so the coding agent knows to pay
attention to the MCP server and use its guide when needed:

```md
This project has an `agent-journal` MCP server providing a persistent knowledge base + journal. Its usage is self-described on connect; call `memory.guide` for the full playbook.
```

The server also returns this same text from `memory.agents_md_snippet`.

## Storage

The server stores data in `memory.db` under the app config directory by default.
Set `AGENT_JOURNAL_DB=/path/to/memory.db` to override the database path.

The app config directory is:

1. `$XDG_CONFIG_DIR/agent-memory` when `XDG_CONFIG_DIR` is set.
2. `$XDG_CONFIG_HOME/agent-memory` when `XDG_CONFIG_HOME` is set.
3. `~/.config/agent-memory` otherwise.

Project config files live beside the database as
`project_<sha256(repo-key)>.json`. The embedding model cache is stored in that
same app config directory.

## Project Identity

The server resolves project identity from, in order:

1. A tool call `project` override.
2. A per-repo config file in the app config directory.
3. Normalized `git remote origin` URL.
4. Main worktree path.
5. Absolute current working directory when outside git.

To create a per-repo config file, first determine the repo key the server would
use: normalized origin URL when available, otherwise the main worktree path.
Then hash it with SHA-256 and write:

```json
{
  "project": "github.com/acme/widgets",
  "config": {
    "tombstone_window": "180d"
  }
}
```

to:

```text
~/.config/agent-memory/project_<sha256(repo-key)>.json
```

Worktrees share the same project key through the main git directory.

## Tools

The v0 server exposes:

- `memory.search`
- `memory.get`
- `memory.recent`
- `memory.stats`
- `memory.guide`
- `memory.agents_md_snippet`
- `kb.upsert_entity`
- `kb.add_statement`
- `kb.edit_statement`
- `kb.invalidate`
- `kb.delete`
- `journal.append`

Use `memory.guide` for the full operating playbook. In short: search before
acting, write atomic statements with honest confidence/provenance, journal what
you did, use immutable edits/invalidation for stale facts, and reserve
`kb.delete` for poisoned content such as secrets or PII.

## Development

```sh
npm install
npm run format
npm run typecheck
npm test
npm run build
```

The unit tests use deterministic stub embeddings and do not download the model.
Run the opt-in real embedding integration test with:

```sh
AGENT_JOURNAL_REAL_EMBEDDINGS=1 npm test
```

## License

[MIT](LICENSE) © Anees Iqbal
