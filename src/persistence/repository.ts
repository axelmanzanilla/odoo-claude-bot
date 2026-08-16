import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  ErrorCategory,
  IncomingRequest,
  RequestStatus,
  SessionMapping,
  StoredRequest,
} from '../domain/types.js';

interface RequestRow {
  id: number;
  user_message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  referenced_message_id: string | null;
  status: RequestStatus;
  parent_session_id: string | null;
  claude_session_id: string | null;
  root_session_id: string | null;
  duration_ms: number | null;
  total_cost_usd: number | null;
  error_category: ErrorCategory | null;
  created_at: string;
  updated_at: string;
}

function fromRequestRow(row: RequestRow): StoredRequest {
  return {
    id: row.id,
    userMessageId: row.user_message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.referenced_message_id === null
      ? {}
      : { referencedMessageId: row.referenced_message_id }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    ...(row.claude_session_id === null ? {} : { claudeSessionId: row.claude_session_id }),
    ...(row.root_session_id === null ? {} : { rootSessionId: row.root_session_id }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.total_cost_usd === null ? {} : { totalCostUsd: row.total_cost_usd }),
    ...(row.error_category === null ? {} : { errorCategory: row.error_category }),
  };
}

export class BotRepository {
  private readonly selectRequest: StatementSync;

  constructor(private readonly database: DatabaseSync) {
    this.selectRequest = database.prepare('SELECT * FROM requests WHERE user_message_id = ?');
  }

  reserve(input: IncomingRequest): { request: StoredRequest; inserted: boolean } {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO requests
          (user_message_id, guild_id, channel_id, thread_id, user_id, referenced_message_id,
           status, parent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        input.userMessageId,
        input.guildId,
        input.channelId,
        input.threadId ?? null,
        input.userId,
        input.referencedMessageId ?? null,
        input.parentSessionId ?? null,
        now,
        now,
      );
    const request = this.findByUserMessageId(input.userMessageId);
    if (!request) throw new Error('Failed to reserve request');
    return { request, inserted: result.changes === 1 };
  }

  findByUserMessageId(messageId: string): StoredRequest | undefined {
    const row = this.selectRequest.get(messageId) as RequestRow | undefined;
    return row ? fromRequestRow(row) : undefined;
  }

  markRunning(requestId: number): boolean {
    return this.transition(requestId, 'queued', 'running');
  }

  storeClaudeResult(
    requestId: number,
    result: { sessionId: string; durationMs?: number; totalCostUsd?: number },
  ): SessionMapping {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const request = this.database
        .prepare('SELECT * FROM requests WHERE id = ?')
        .get(requestId) as RequestRow | undefined;
      if (!request || request.status !== 'running') throw new Error('Request is not running');
      const rootSessionId = request.parent_session_id
        ? this.resolveRootSession(request.parent_session_id)
        : result.sessionId;
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO claude_sessions
            (session_id, parent_session_id, root_session_id, request_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(result.sessionId, request.parent_session_id, rootSessionId, requestId, now);
      this.database
        .prepare(
          `UPDATE requests SET status = 'succeeded', claude_session_id = ?, root_session_id = ?,
            duration_ms = ?, total_cost_usd = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          result.sessionId,
          rootSessionId,
          result.durationMs ?? null,
          result.totalCostUsd ?? null,
          now,
          requestId,
        );
      this.database.exec('COMMIT');
      return {
        sessionId: result.sessionId,
        rootSessionId,
        requestId,
        ...(request.parent_session_id === null
          ? {}
          : { parentSessionId: request.parent_session_id }),
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  mapResponseChunk(input: {
    requestId: number;
    botMessageId: string;
    sessionId: string;
    chunkIndex: number;
    channelId: string;
  }): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO response_chunks
          (bot_message_id, request_id, session_id, chunk_index, channel_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.botMessageId,
        input.requestId,
        input.sessionId,
        input.chunkIndex,
        input.channelId,
        new Date().toISOString(),
      );
  }

  resolveBotMessage(botMessageId: string): SessionMapping | undefined {
    const row = this.database
      .prepare(
        `SELECT c.session_id, s.parent_session_id, s.root_session_id, c.request_id
         FROM response_chunks c JOIN claude_sessions s ON s.session_id = c.session_id
         WHERE c.bot_message_id = ?`,
      )
      .get(botMessageId) as
      | {
          session_id: string;
          parent_session_id: string | null;
          root_session_id: string;
          request_id: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      rootSessionId: row.root_session_id,
      requestId: row.request_id,
      ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    };
  }

  markFailed(requestId: number, category: ErrorCategory): void {
    this.database
      .prepare(
        `UPDATE requests SET status = 'failed', error_category = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(category, new Date().toISOString(), requestId);
  }

  markCancelled(requestId: number): void {
    this.database
      .prepare(
        `UPDATE requests SET status = 'cancelled', error_category = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(new Date().toISOString(), requestId);
  }

  markDelivery(requestId: number, status: 'pending' | 'sending' | 'sent' | 'failed'): void {
    this.database
      .prepare('UPDATE requests SET delivery_status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), requestId);
  }

  countResponseChunks(requestId: number): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM response_chunks WHERE request_id = ?')
      .get(requestId) as { count: number };
    return row.count;
  }

  private transition(requestId: number, from: RequestStatus, to: RequestStatus): boolean {
    const result = this.database
      .prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, new Date().toISOString(), requestId, from);
    return result.changes === 1;
  }

  private resolveRootSession(sessionId: string): string {
    const row = this.database
      .prepare('SELECT root_session_id FROM claude_sessions WHERE session_id = ?')
      .get(sessionId) as { root_session_id: string } | undefined;
    if (!row) throw new Error('Parent session does not exist');
    return row.root_session_id;
  }
}
