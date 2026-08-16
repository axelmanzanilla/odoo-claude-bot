import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/database.js';
import { BotRepository } from '../../src/persistence/repository.js';

const directories: string[] = [];

function createDatabase(): { database: DatabaseSync; path: string; repository: BotRepository } {
  const directory = mkdtempSync(join(tmpdir(), 'odoo-claude-bot-'));
  directories.push(directory);
  const path = join(directory, 'bot.sqlite3');
  const database = openDatabase(path);
  return { database, path, repository: new BotRepository(database) };
}

function reserve(repository: BotRepository, messageId = '100000000000000001') {
  return repository.reserve({
    userMessageId: messageId,
    guildId: '200000000000000001',
    channelId: '300000000000000001',
    userId: '400000000000000001',
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('BotRepository', () => {
  it('reserves each Discord input exactly once', () => {
    const { database, repository } = createDatabase();
    const first = reserve(repository);
    const duplicate = reserve(repository);
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.request.id).toBe(first.request.id);
    database.close();
  });

  it('persists sessions and every response chunk across restarts', () => {
    const { database, path, repository } = createDatabase();
    const { request } = reserve(repository);
    expect(repository.markRunning(request.id)).toBe(true);
    repository.storeClaudeResult(request.id, {
      sessionId: 'session-a',
      durationMs: 12,
      totalCostUsd: 0.01,
    });
    repository.mapResponseChunk({
      requestId: request.id,
      sessionId: 'session-a',
      botMessageId: '500000000000000001',
      chunkIndex: 0,
      channelId: request.channelId,
    });
    repository.mapResponseChunk({
      requestId: request.id,
      sessionId: 'session-a',
      botMessageId: '500000000000000002',
      chunkIndex: 1,
      channelId: request.channelId,
    });
    database.close();

    const reopened = openDatabase(path);
    const restartedRepository = new BotRepository(reopened);
    expect(restartedRepository.resolveBotMessage('500000000000000001')?.sessionId).toBe(
      'session-a',
    );
    expect(restartedRepository.resolveBotMessage('500000000000000002')?.sessionId).toBe(
      'session-a',
    );
    expect(restartedRepository.countResponseChunks(request.id)).toBe(2);
    reopened.close();
  });

  it('records independent forks with the same root ancestry', () => {
    const { database, repository } = createDatabase();
    const root = reserve(repository, '100000000000000001').request;
    repository.markRunning(root.id);
    repository.storeClaudeResult(root.id, { sessionId: 'root' });
    repository.mapResponseChunk({
      requestId: root.id,
      sessionId: 'root',
      botMessageId: '500000000000000001',
      chunkIndex: 0,
      channelId: root.channelId,
    });

    for (const [index, sessionId] of ['branch-a', 'branch-b'].entries()) {
      const branch = repository.reserve({
        userMessageId: `10000000000000000${index + 2}`,
        guildId: root.guildId,
        channelId: root.channelId,
        userId: root.userId,
        referencedMessageId: '500000000000000001',
        parentSessionId: 'root',
      }).request;
      repository.markRunning(branch.id);
      const mapping = repository.storeClaudeResult(branch.id, { sessionId });
      expect(mapping.rootSessionId).toBe('root');
      expect(mapping.parentSessionId).toBe('root');
    }
    database.close();
  });

  it('does not store prompt or response content', () => {
    const { database, repository } = createDatabase();
    reserve(repository);
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('requests')")
      .all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).not.toContain('prompt');
    expect(columns.map(({ name }) => name)).not.toContain('response');
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    database.close();
  });

  it('rolls back a failed session transaction without partial rows', () => {
    const { database, repository } = createDatabase();
    const request = repository.reserve({
      userMessageId: '100000000000000001',
      guildId: '200000000000000001',
      channelId: '300000000000000001',
      userId: '400000000000000001',
      parentSessionId: 'missing-parent',
    }).request;
    repository.markRunning(request.id);
    expect(() => repository.storeClaudeResult(request.id, { sessionId: 'orphan' })).toThrow(
      'Parent session does not exist',
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM claude_sessions').get()).toEqual({
      count: 0,
    });
    expect(repository.findByUserMessageId(request.userMessageId)?.status).toBe('running');
    database.close();
  });
});
