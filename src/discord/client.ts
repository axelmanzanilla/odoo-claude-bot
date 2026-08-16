import { Client, Events, GatewayIntentBits, type Message, type PartialMessage } from 'discord.js';
import type { Logger } from 'pino';
import type { DiscordMessageEnvelope } from './handler.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

export function registerMessageHandler(
  client: Client,
  handler: (message: DiscordMessageEnvelope) => Promise<void>,
  logger: Logger,
): () => void {
  const listener = (message: Message) => {
    const envelope = toEnvelope(message, client.user?.id ?? '');
    void handler(envelope).catch(() => {
      logger.error(
        { messageId: message.id, channelId: message.channelId },
        'Unhandled message failure',
      );
    });
  };
  client.on(Events.MessageCreate, listener);
  return () => client.off(Events.MessageCreate, listener);
}

function toEnvelope(message: Message, botUserId: string): DiscordMessageEnvelope {
  const isThread = message.channel.isThread();
  return {
    id: message.id,
    content: message.content,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    threadId: isThread ? message.channelId : undefined,
    parentChannelId: isThread ? (message.channel.parentId ?? undefined) : undefined,
    channelOwnerId: isThread ? (message.channel.ownerId ?? undefined) : undefined,
    mentionsBot: message.mentions.users.has(botUserId),
    referencedMessageId: message.reference?.messageId,
    webhookId: message.webhookId ?? undefined,
    async fetchReferenced() {
      try {
        const referenced = await message.fetchReference();
        return { id: referenced.id, authorId: referenced.author.id };
      } catch {
        return undefined;
      }
    },
    async reply(content) {
      const sent = await message.reply({
        content,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return { id: sent.id };
    },
    async react(emoji) {
      if (emoji !== '⏳') await removeWorkingReaction(message, botUserId);
      await message.react(emoji);
    },
  };
}

async function removeWorkingReaction(
  message: Message | PartialMessage,
  botUserId: string,
): Promise<void> {
  try {
    await message.reactions.resolve('⏳')?.users.remove(botUserId);
  } catch {
    // A missing reaction or Discord permission must not hide the final status.
  }
}
