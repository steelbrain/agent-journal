# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `kb.delete` on an entity no longer fails with a foreign-key error: it now
  cascades to the entity's statements and relationships, cleaning their search
  index entries, journal links, and inbound redirects, and records the cascade
  in the audit journal entry.
- `memory.recent` no longer silently drops records that share a `created_at`
  with a page boundary. Paging now uses a compound cursor: pass the returned
  `next_before` and `next_before_id` back as `before` and `before_id`.
- A busy checkpoint or vacuum after `kb.delete` is no longer reported as a
  failed deletion; the result now carries `vacuum_completed` instead.

### Changed

- Schema v2: search indexes are project-scoped. The vector index is
  partitioned by project with owner type and status metadata, and the FTS
  tables carry project/status columns, so search recall budgets apply per
  project and per store instead of to one global pool, and invalidated
  tombstones stop consuming recall slots unless `include_invalid` is set.
  Existing databases migrate automatically; vectors are copied without
  re-embedding.
- `kb.upsert_entity` title changes now re-embed the entity's statements so
  semantic search reflects the new title (previously only keyword search was
  re-synced).
- `memory.recent` pages via SQL ordering and aggregates instead of loading
  whole tables into memory.
- Deletion audit journal entries are now keyword-searchable.

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
