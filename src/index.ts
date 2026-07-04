import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDbPath, openDb } from './db/connection.js';
import { TransformersEmbeddings } from './domain/embeddings.js';
import { ProjectResolver } from './domain/project.js';
import { dumpMemory } from './dump.js';
import { createMcpServer, connectStdio } from './server.js';
import { MemoryApi } from './tools/api.js';

function readVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function helpText(version: string): string {
  return `agent-journal v${version}

A local, project-scoped MCP server that gives coding agents a persistent
knowledge base and journal. It is meant to be launched by an agent with the
--mcp flag, not run directly in a terminal.

Add it to Claude Code:

  claude mcp add agent-journal -- npx -y agent-journal --mcp

Add it to Codex:

  codex mcp add agent-journal -- npx -y agent-journal --mcp

Or add this server entry to your client's MCP config file (commonly .mcp.json):

  {
    "mcpServers": {
      "agent-journal": {
        "command": "npx",
        "args": ["-y", "agent-journal", "--mcp"]
      }
    }
  }

Options:
  --mcp            Run as an MCP server
  --dump           Write the current project's knowledge base and journal to
                   .agents/knowledge-base and .agents/journal as markdown
  -h, --help       Show this help text
  -v, --version    Print the version

Environment:
  AGENT_JOURNAL_DB   Override the database path (defaults to memory.db under the
                     app config directory)

Docs: https://github.com/steelbrain/agent-journal#readme`;
}

function runDump(): void {
  const db = openDb(defaultDbPath());
  try {
    const resolver = new ProjectResolver(db, process.cwd());
    const result = dumpMemory(db, resolver, process.cwd());
    process.stdout.write(
      `Dumped ${result.entities} entities with ${result.statements} statements, ` +
        `${result.journalEntries} journal entries` +
        `${result.relationships > 0 ? `, ${result.relationships} relationships` : ''} ` +
        `(${result.filesWritten} files).\n` +
        `  ${path.relative(process.cwd(), result.kbDir) || result.kbDir}\n` +
        `  ${path.relative(process.cwd(), result.journalDir) || result.journalDir}\n`,
    );
  } finally {
    db.close();
  }
}

async function serve(version: string): Promise<void> {
  const dbFile = defaultDbPath();
  const db = openDb(dbFile);
  const resolver = new ProjectResolver(db, process.cwd());
  resolver.resolve();

  const embeddings = new TransformersEmbeddings();
  const api = new MemoryApi({ db, resolver, embeddings, dbFile });
  const server = createMcpServer(api, version);

  embeddings.warmup();
  await connectStdio(server);
}

async function main(): Promise<void> {
  const version = readVersion();
  const args = process.argv.slice(2);

  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${version}\n`);
    return;
  }

  if (args.includes('--dump')) {
    runDump();
    return;
  }

  // Serving requires the explicit --mcp flag. Everything else, including a bare
  // invocation, prints help so running this in a terminal never hangs on a
  // protocol handshake that will never arrive.
  if (args.includes('--mcp')) {
    await serve(version);
    return;
  }

  process.stdout.write(`${helpText(version)}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error && err.stack ? err.stack : err);
  process.exitCode = 1;
});
