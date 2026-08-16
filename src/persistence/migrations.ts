import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY,
        user_message_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        referenced_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        parent_session_id TEXT,
        claude_session_id TEXT,
        root_session_id TEXT,
        duration_ms INTEGER,
        total_cost_usd REAL,
        error_category TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
        CHECK (total_cost_usd IS NULL OR total_cost_usd >= 0)
      );

      CREATE TABLE claude_sessions (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT REFERENCES claude_sessions(session_id),
        root_session_id TEXT NOT NULL,
        request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE response_chunks (
        bot_message_id TEXT PRIMARY KEY,
        request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES claude_sessions(session_id),
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (request_id, chunk_index)
      );

      CREATE INDEX response_chunks_session_idx ON response_chunks(session_id);
      CREATE INDEX requests_status_idx ON requests(status);
    `,
  },
];

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map(({ version }) => version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
