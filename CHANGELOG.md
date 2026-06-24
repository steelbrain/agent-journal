# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

### Added

- Initial release of the `agent-journal` MCP server: a local, project-scoped
  knowledge base and journal for coding agents.
- Knowledge base of immutable, confidence-tracked statements attached to
  entities, with immutable edits and invalidation instead of in-place updates.
- Append-only journal recording what was done and what was proven, with links
  to knowledge-base records.
- Search over both stores via SQLite FTS5 and sqlite-vec, backed by local
  embeddings, with humanized relative timestamps on results.
- MCP tools: `memory.search`, `memory.get`, `memory.recent`, `memory.stats`,
  `memory.guide`, `memory.agents_md_snippet`, `kb.upsert_entity`,
  `kb.add_statement`, `kb.edit_statement`, `kb.invalidate`, `kb.delete`, and
  `journal.append`.
- Automatic project resolution from git remote, worktree, or working directory,
  with per-repo config files under the XDG app config directory.
- `--mcp` flag to run as a server; bare invocation prints help and `--version`
  reports the version.

[Unreleased]: https://github.com/steelbrain/agent-journal/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/steelbrain/agent-journal/releases/tag/v0.1.0
