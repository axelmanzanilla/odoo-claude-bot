import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeGateway, ClaudeTurnResult } from '../../src/claude/gateway.js';
import { parseConfig } from '../../src/config.js';
import {
  DiscordMessageHandler,
  type DiscordMessageEnvelope,
  type ReferencedMessage,
} from '../../src/discord/handler.js';
import { ReadinessState } from '../../src/health.js';
import { createLogger } from '../../src/logger.js';
import { openDatabase } from '../../src/persistence/database.js';
import { BotRepository } from '../../src/persistence/repository.js';
import { RequestScheduler } from '../../src/queue/scheduler.js';

const BOT_ID = '900000000000000001';
const USER_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const CHANNEL_ID = '300000000000000001';
const APP_ID = '800000000000000001';
const directories: string[] = [];

class FakeGateway implements ClaudeGateway {
  readonly creates: string[] = [];
  readonly forks: Array<{ parent: string; prompt: string }> = [];
  private count = 0;
  responseText = '';

  create(prompt: string): Promise<ClaudeTurnResult> {
    this.creates.push(prompt);
    this.count += 1;
    return Promise.resolve({
      sessionId: `session-${this.count}`,
      text: this.responseText || `answer ${this.count}`,
    });
  }

  forkAndContinue(parentSessionId: string, prompt: string): Promise<ClaudeTurnResult> {
    this.forks.push({ parent: parentSessionId, prompt });
    this.count += 1;
    return Promise.resolve({
      sessionId: `session-${this.count}`,
      text: this.responseText || `answer ${this.count}`,
    });
  }
}

class FakeMessage implements DiscordMessageEnvelope {
  readonly authorId = USER_ID;
  readonly authorIsBot = false;
  readonly guildId = GUILD_ID;
  readonly channelId = CHANNEL_ID;
  readonly mentionsBot: boolean;
  readonly replies: Array<{ id: string; content: string }> = [];
  readonly reactions: string[] = [];
  fetchCount = 0;
  failSends = 0;

  constructor(
    readonly id: string,
    readonly content: string,
    readonly referencedMessageId?: string,
    private readonly referenced?: ReferencedMessage,
    mentionsBot = true,
  ) {
    this.mentionsBot = mentionsBot;
  }

  fetchReferenced(): Promise<ReferencedMessage | undefined> {
    this.fetchCount += 1;
    return Promise.resolve(this.referenced);
  }

  reply(content: string): Promise<{ id: string }> {
    if (this.failSends > 0) {
      this.failSends -= 1;
      return Promise.reject(new Error('Discord API details'));
    }
    const sent = { id: `reply-${this.id}-${this.replies.length}`, content };
    this.replies.push(sent);
    return Promise.resolve(sent);
  }

  react(emoji: string): Promise<void> {
    this.reactions.push(emoji);
    return Promise.resolve();
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'handler-test-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'bot.sqlite3'));
  const repository = new BotRepository(database);
  const gateway = new FakeGateway();
  const config = parseConfig({
    DISCORD_TOKEN: 'placeholder',
    DISCORD_APPLICATION_ID: APP_ID,
    DISCORD_ALLOWED_USER_IDS: USER_ID,
    DISCORD_ALLOWED_GUILD_IDS: GUILD_ID,
    DISCORD_ALLOWED_CHANNEL_IDS: CHANNEL_ID,
  });
  const readiness = new ReadinessState();
  for (const component of ['configuration', 'database', 'claude', 'mcp', 'discord'] as const) {
    readiness.set(component, 'ready');
  }
  const scheduler = new RequestScheduler(1, 10);
  const handler = new DiscordMessageHandler(
    config,
    BOT_ID,
    repository,
    gateway,
    scheduler,
    readiness,
    createLogger('silent'),
  );
  return { database, repository, gateway, handler };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('DiscordMessageHandler', () => {
  it.each([
    ['another user', { id: '500000000000000001', authorId: USER_ID }],
    ['another bot', { id: '500000000000000001', authorId: '700000000000000001' }],
    ['a missing message', undefined],
    ['a mismatched bot message', { id: '500000000000000002', authorId: BOT_ID }],
  ] as const)('silently ignores an image-only reply to %s', async (_label, reference) => {
    const { database, repository, gateway, handler } = fixture();
    const reserve = vi.spyOn(repository, 'reserve');
    const resolve = vi.spyOn(repository, 'resolveBotMessage');
    const message = new FakeMessage(
      '400000000000000001',
      '',
      '500000000000000001',
      reference,
      false,
    );
    await handler.handle(message);
    expect(message.fetchCount).toBe(1);
    expect(message.replies).toEqual([]);
    expect(message.reactions).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(gateway.creates).toEqual([]);
    expect(gateway.forks).toEqual([]);
    database.close();
  });

  it.each(['mention', 'reply', 'thread'] as const)(
    'still requests text for an empty prompt directed at the bot via %s',
    async (kind) => {
      const { database, gateway, handler } = fixture();
      const message = new FakeMessage(
        '400000000000000001',
        kind === 'mention' ? `<@${APP_ID}>` : '',
        kind === 'reply' ? '500000000000000001' : undefined,
        kind === 'reply' ? { id: '500000000000000001', authorId: BOT_ID } : undefined,
        kind === 'mention',
      );
      if (kind === 'thread') Object.defineProperty(message, 'channelOwnerId', { value: BOT_ID });
      await handler.handle(message);
      expect(message.replies.map(({ content }) => content)).toEqual([
        'Please include a text request.',
      ]);
      expect(gateway.creates).toEqual([]);
      expect(gateway.forks).toEqual([]);
      database.close();
    },
  );

  it('creates a new session and maps every output message', async () => {
    const { database, repository, gateway, handler } = fixture();
    const message = new FakeMessage('400000000000000001', `<@${APP_ID}> estimate this`);
    await handler.handle(message);
    expect(gateway.creates).toEqual(['estimate this']);
    expect(message.reactions).toEqual(['⏳', '✅']);
    expect(repository.resolveBotMessage(message.replies[0]!.id)?.sessionId).toBe('session-1');
    database.close();
  });

  it('forks the exact referenced session and supports two independent branches', async () => {
    const { database, repository, gateway, handler } = fixture();
    const root = new FakeMessage('400000000000000001', `<@${APP_ID}> root`);
    await handler.handle(root);
    const botMessageId = root.replies[0]!.id;
    const reference = { id: botMessageId, authorId: BOT_ID };
    const branchA = new FakeMessage(
      '400000000000000002',
      'branch A',
      botMessageId,
      reference,
      false,
    );
    const branchB = new FakeMessage(
      '400000000000000003',
      'branch B',
      botMessageId,
      reference,
      false,
    );
    await handler.handle(branchA);
    await handler.handle(branchB);
    expect(gateway.forks).toEqual([
      { parent: 'session-1', prompt: 'branch A' },
      { parent: 'session-1', prompt: 'branch B' },
    ]);
    expect(repository.resolveBotMessage(branchA.replies[0]!.id)?.sessionId).toBe('session-2');
    expect(repository.resolveBotMessage(branchB.replies[0]!.id)?.sessionId).toBe('session-3');
    database.close();
  });

  it('ignores unauthorized events before fetch, database reservation, or Claude', async () => {
    const { database, gateway, handler } = fixture();
    const message = new FakeMessage('400000000000000001', 'reply', 'unknown', undefined, false);
    Object.defineProperty(message, 'authorId', { value: '700000000000000001' });
    const fetchSpy = vi.spyOn(message, 'fetchReferenced');
    await handler.handle(message);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(gateway.creates).toHaveLength(0);
    expect(gateway.forks).toHaveLength(0);
    database.close();
  });

  it('does not guess when a referenced bot response is unmapped', async () => {
    const { database, gateway, handler } = fixture();
    const message = new FakeMessage(
      '400000000000000001',
      'continue',
      '500000000000000001',
      { id: '500000000000000001', authorId: BOT_ID },
      false,
    );
    await handler.handle(message);
    expect(message.replies[0]?.content).toContain('no longer has a saved Claude session');
    expect(gateway.forks).toHaveLength(0);
    database.close();
  });

  it('does not accept a control command merely because it replies to a foreign bot', async () => {
    const { database, gateway, handler } = fixture();
    const message = new FakeMessage(
      '400000000000000001',
      'health',
      '500000000000000001',
      { id: '500000000000000001', authorId: '700000000000000001' },
      false,
    );
    await handler.handle(message);
    expect(message.fetchCount).toBe(1);
    expect(message.replies).toHaveLength(0);
    expect(gateway.creates).toHaveLength(0);
    database.close();
  });

  it('is idempotent and retries a Discord send without invoking Claude twice', async () => {
    const { database, gateway, handler } = fixture();
    const message = new FakeMessage('400000000000000001', `<@${APP_ID}> hello`);
    message.failSends = 1;
    await handler.handle(message);
    await handler.handle(message);
    expect(gateway.creates).toHaveLength(1);
    expect(message.replies).toHaveLength(1);
    database.close();
  });

  it('maps every long-response chunk so each one can be used as the exact reply parent', async () => {
    const { database, repository, gateway, handler } = fixture();
    gateway.responseText = 'long response '.repeat(300);
    const root = new FakeMessage('400000000000000001', `<@${APP_ID}> long`);
    await handler.handle(root);
    expect(root.replies.length).toBeGreaterThan(1);
    for (const reply of root.replies) {
      expect(repository.resolveBotMessage(reply.id)?.sessionId).toBe('session-1');
    }

    gateway.responseText = '';
    for (const [index, reply] of root.replies.slice(0, 2).entries()) {
      const branch = new FakeMessage(
        `40000000000000000${index + 2}`,
        `from chunk ${index}`,
        reply.id,
        { id: reply.id, authorId: BOT_ID },
        false,
      );
      await handler.handle(branch);
    }
    expect(gateway.forks.slice(-2).map(({ parent }) => parent)).toEqual(['session-1', 'session-1']);
    database.close();
  });

  it('does not recompute after a permanent Discord delivery failure', async () => {
    const { database, gateway, handler } = fixture();
    const message = new FakeMessage('400000000000000001', `<@${APP_ID}> hello`);
    message.failSends = 3;
    await handler.handle(message);
    await handler.handle(message);
    expect(gateway.creates).toHaveLength(1);
    expect(message.replies.at(-1)?.content).toBe('answer 1');
    database.close();
  });
});
