# Agent Instructions

This project has an `agent-journal` MCP server providing a persistent knowledge base + journal. Its usage is self-described on connect; call `memory.guide` for the full playbook.

## Project Overview

`agent-journal` is a TypeScript ESM MCP stdio server for local, project-scoped agent memory. It stores a confidence-tracked knowledge base and append-only journal in SQLite, with FTS5 and sqlite-vec search plus local embeddings.

Core runtime expectations:

- Node.js 20 or newer.
- TypeScript ESM only.
- SQLite access uses `better-sqlite3`.
- Vector search uses `sqlite-vec`.
- Embeddings use `@huggingface/transformers`.
- Build output is checked in under `dist/` because the package `bin` points to `dist/index.js`.

## Common Commands

Use these commands before handing off substantive changes:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
```

Use `npm run format` to apply formatting. Formatting is Biome-only; linting is intentionally disabled.

Use `npm ci` when validating the lockfile or matching CI.

The real embedding integration test is opt-in and may download model files:

```sh
AGENT_JOURNAL_REAL_EMBEDDINGS=1 npm test
```

Do not run the real embedding test unless it is relevant or requested.

## Code Style

- Use single quotes in TypeScript and JavaScript.
- Keep formatting delegated to Biome.
- Do not add lint rules unless explicitly requested.
- Keep code comments sparse and useful.
- Keep generated `dist/` output in sync with source changes by running `npm run build`.
- Do not write application logs to stdout in server code; stdout is reserved for MCP protocol traffic. Use stderr for diagnostics.

## Implementation Notes

- Tool handlers live behind the `MemoryApi` API so tests can exercise behavior without stdio.
- Mutating DB operations should use retry-wrapped transactions and run incremental vacuum through the existing mutation path.
- Statements are immutable. Edits should create a replacement statement and invalidate the old one.
- Invalid records remain readable but are excluded from search by default.
- `kb.delete` is only for poisoned content such as secrets, credentials, PII, or garbage that must not persist.
- Project config and model cache live under the XDG app config directory, using the `agent-memory` directory name for compatibility with the current implementation.

## Testing Guidance

- Prefer deterministic stub embeddings for unit tests.
- Add tests for changes to DB migrations, project resolution, search ranking/filtering, journal links, deletion cleanup, or MCP tool registration.
- Keep tests isolated with temporary DB files.
- If a change affects packaging or the CLI, verify `dist/index.js` has the shebang and executable bit and run an MCP stdio smoke check when practical.

## Repository Hygiene

- Do not revert unrelated user changes.
- `node_modules/` is ignored and should not be committed.
- If source files change, update `dist/` in the same change.
- CI runs `npm ci`, `npm run format:check`, and `npm run typecheck`.
