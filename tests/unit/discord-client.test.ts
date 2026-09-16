import { Collection, Events, MessageReferenceType, MessageType, type Message } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { authorize } from '../../src/discord/authorization.js';
import { createDiscordClient, registerMessageHandler } from '../../src/discord/client.js';
import type { DiscordMessageEnvelope } from '../../src/discord/handler.js';
import { createLogger } from '../../src/logger.js';

const BOT_ID = '900000000000000001';
const USER_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const CHANNEL_ID = '300000000000000001';
const REFERENCE_ID = '500000000000000001';

describe('Discord message reference classification', () => {
  it.each([
    ['reply', MessageType.Reply, MessageReferenceType.Default, true],
    ['legacy reply', MessageType.Reply, undefined, true],
    ['forward', MessageType.Default, MessageReferenceType.Forward, false],
    ['forward with reply type', MessageType.Reply, MessageReferenceType.Forward, false],
    ['crosspost', MessageType.Default, MessageReferenceType.Default, false],
  ] as const)(
    'classifies a %s before authorization',
    async (_label, type, referenceType, isReply) => {
      const client = createDiscordClient();
      Object.defineProperty(client, 'user', { value: { id: BOT_ID } });
      const handler = vi
        .fn<(message: DiscordMessageEnvelope) => Promise<void>>()
        .mockResolvedValue();
      const unregister = registerMessageHandler(client, handler, createLogger('silent'));
      const fetchReference = vi.fn();
      const reply = vi.fn();
      const message = {
        id: '400000000000000001',
        content: '',
        type,
        author: { id: USER_ID, bot: false },
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        channel: { isThread: () => false },
        mentions: { users: new Collection() },
        reference: { type: referenceType, messageId: REFERENCE_ID },
        fetchReference,
        reply,
      } as unknown as Message<true>;

      try {
        client.emit(Events.MessageCreate, message);
        const envelope = handler.mock.calls[0]![0];
        expect(envelope.referencedMessageId).toBe(isReply ? REFERENCE_ID : undefined);
        expect(
          authorize(
            {
              authorId: envelope.authorId,
              authorIsBot: envelope.authorIsBot,
              guildId: GUILD_ID,
              channelId: envelope.channelId,
              mentionsBot: envelope.mentionsBot,
              botOwnsThread: false,
              hasReplyReference: envelope.referencedMessageId !== undefined,
            },
            {
              allowedUserIds: new Set([USER_ID]),
              allowedGuildIds: new Set([GUILD_ID]),
              allowedChannelIds: new Set([CHANNEL_ID]),
            },
          ).allowed,
        ).toBe(isReply);
        expect(fetchReference).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
      } finally {
        unregister();
        await client.destroy();
      }
    },
  );
});
