import type { Logger } from 'pino';
import type { ClaudeGateway } from '../claude/gateway.js';
import { safeClaudeError } from '../claude/errors.js';
import type { AppConfig } from '../config.js';
import type { ErrorCategory } from '../domain/types.js';
import type { BotRepository } from '../persistence/repository.js';
import type { RequestScheduler } from '../queue/scheduler.js';
import type { ReadinessState } from '../health.js';
import { authorize, normalizePrompt } from './authorization.js';
import { splitDiscordOutput } from './output.js';

export interface ReferencedMessage {
  readonly id: string;
  readonly authorId: string;
}

export interface SentMessage {
  readonly id: string;
}

export interface DiscordMessageEnvelope {
  readonly id: string;
  readonly content: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly webhookId?: string | undefined;
  readonly guildId?: string | undefined;
  readonly channelId: string;
  readonly threadId?: string | undefined;
  readonly parentChannelId?: string | undefined;
  readonly channelOwnerId?: string | undefined;
  readonly mentionsBot: boolean;
  readonly referencedMessageId?: string | undefined;
  fetchReferenced(): Promise<ReferencedMessage | undefined>;
  reply(content: string): Promise<SentMessage>;
  react(emoji: string): Promise<void>;
}

interface PendingDelivery {
  readonly requestId: number;
  readonly sessionId: string;
  readonly channelId: string;
  readonly chunks: readonly string[];
  nextIndex: number;
}

export class DiscordMessageHandler {
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();

  constructor(
    private readonly config: AppConfig,
    private readonly botUserId: string,
    private readonly repository: BotRepository,
    private readonly claude: ClaudeGateway,
    private readonly scheduler: RequestScheduler,
    private readonly readiness: ReadinessState,
    private readonly logger: Logger,
  ) {}

  async handle(message: DiscordMessageEnvelope): Promise<void> {
    const decision = authorize(
      {
        authorId: message.authorId,
        authorIsBot: message.authorIsBot,
        channelId: message.channelId,
        mentionsBot: message.mentionsBot,
        botOwnsThread: message.channelOwnerId === this.botUserId,
        hasReplyReference: message.referencedMessageId !== undefined,
        ...(message.webhookId === undefined ? {} : { webhookId: message.webhookId }),
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
        ...(message.parentChannelId === undefined
          ? {}
          : { parentChannelId: message.parentChannelId }),
      },
      this.config,
    );
    if (!decision.allowed) {
      this.logger.debug(
        {
          reason: decision.reason,
          userId: message.authorId,
          guildId: message.guildId,
          channelId: message.channelId,
        },
        'Ignored Discord message',
      );
      return;
    }

    let prompt = normalizePrompt(message.content, this.config.discordApplicationId);
    if (!prompt) {
      await this.safeReply(message, 'Please include a request after mentioning me.');
      return;
    }

    let fetchedReference: ReferencedMessage | undefined;
    if (
      message.referencedMessageId &&
      !message.mentionsBot &&
      message.channelOwnerId !== this.botUserId
    ) {
      fetchedReference = await message.fetchReferenced();
      if (!fetchedReference || fetchedReference.authorId !== this.botUserId) return;
    }

    const command = prompt.match(/^(health|status|cancel|new)(?:\s+([\s\S]*))?$/i);
    if (command?.[1]?.toLowerCase() === 'health') {
      await this.safeReply(message, this.readiness.summary());
      return;
    }
    if (command?.[1]?.toLowerCase() === 'status') {
      const status = this.scheduler.status();
      await this.safeReply(
        message,
        `Scheduler ${status.accepting ? 'accepting work' : 'stopping'}; ${status.active} active, ${status.queued} queued.`,
      );
      return;
    }
    if (command?.[1]?.toLowerCase() === 'cancel') {
      const targetId = command[2]?.trim();
      const target = targetId ? this.repository.findByUserMessageId(targetId) : undefined;
      const cancelled = Boolean(
        target && target.userId === message.authorId && this.scheduler.cancel(target.userMessageId),
      );
      await this.safeReply(
        message,
        cancelled ? 'Cancellation requested.' : 'No cancellable request was found.',
      );
      return;
    }
    const forceNew = command?.[1]?.toLowerCase() === 'new';
    if (forceNew) {
      prompt = command?.[2]?.trim() ?? '';
      if (!prompt) {
        await this.safeReply(message, 'Include a request after `new`.');
        return;
      }
    }
    if (!this.readiness.isReady()) {
      await this.safeReply(
        message,
        'The Odoo assistant is not ready. Use `health` for component status.',
      );
      return;
    }

    let parentSessionId: string | undefined;
    let lineageKey = message.id;
    if (message.referencedMessageId && !forceNew) {
      const referenced = fetchedReference ?? (await message.fetchReferenced());
      if (
        !referenced ||
        referenced.id !== message.referencedMessageId ||
        referenced.authorId !== this.botUserId
      ) {
        await this.safeReply(
          message,
          'I cannot recover a Claude session from that reply. Mention me with a new request to start fresh.',
        );
        return;
      }
      const mapping = this.repository.resolveBotMessage(referenced.id);
      if (!mapping) {
        await this.safeReply(
          message,
          'That response no longer has a saved Claude session. Mention me with a new request to start fresh.',
        );
        return;
      }
      parentSessionId = mapping.sessionId;
      lineageKey = mapping.rootSessionId;
    }

    const reservation = this.repository.reserve({
      userMessageId: message.id,
      guildId: message.guildId!,
      channelId: message.channelId,
      userId: message.authorId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.referencedMessageId === undefined
        ? {}
        : { referencedMessageId: message.referencedMessageId }),
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    });
    if (!reservation.inserted) {
      const pending = this.pendingDeliveries.get(message.id);
      if (pending) {
        try {
          await this.deliver(message, pending);
          this.pendingDeliveries.delete(message.id);
          this.repository.markDelivery(pending.requestId, 'sent');
          await this.tryReact(message, '✅');
        } catch {
          this.repository.markDelivery(pending.requestId, 'failed');
        }
      }
      return;
    }

    await this.tryReact(message, '⏳');
    let resultStored = false;
    try {
      const result = await this.scheduler.schedule(message.id, lineageKey, async (signal) => {
        if (!this.repository.markRunning(reservation.request.id)) {
          throw new Error('Request is no longer queued');
        }
        return parentSessionId
          ? await this.claude.forkAndContinue(parentSessionId, prompt, signal)
          : await this.claude.create(prompt, signal);
      });
      this.repository.storeClaudeResult(reservation.request.id, result);
      resultStored = true;
      this.repository.markDelivery(reservation.request.id, 'sending');
      const chunks = splitDiscordOutput(result.text);
      const pending: PendingDelivery = {
        requestId: reservation.request.id,
        sessionId: result.sessionId,
        channelId: message.channelId,
        chunks,
        nextIndex: 0,
      };
      this.pendingDeliveries.set(message.id, pending);
      await this.deliver(message, pending);
      this.pendingDeliveries.delete(message.id);
      this.repository.markDelivery(reservation.request.id, 'sent');
      await this.tryReact(message, '✅');
    } catch (error) {
      const claudeError = safeClaudeError(error);
      if (resultStored) this.repository.markDelivery(reservation.request.id, 'failed');
      else if (claudeError.category === 'cancelled') {
        this.repository.markCancelled(reservation.request.id);
      } else this.repository.markFailed(reservation.request.id, claudeError.category);
      this.logger.error(
        { category: claudeError.category, requestId: reservation.request.id },
        'Discord request failed',
      );
      await this.tryReact(message, '❌');
      await this.safeReply(message, userError(claudeError.category));
    }
  }

  private async sendWithRetry(
    message: DiscordMessageEnvelope,
    content: string,
  ): Promise<SentMessage> {
    try {
      return await message.reply(content);
    } catch {
      return await message.reply(content);
    }
  }

  private async deliver(message: DiscordMessageEnvelope, pending: PendingDelivery): Promise<void> {
    while (pending.nextIndex < pending.chunks.length) {
      const index = pending.nextIndex;
      const sent = await this.sendWithRetry(message, pending.chunks[index]!);
      this.repository.mapResponseChunk({
        requestId: pending.requestId,
        botMessageId: sent.id,
        sessionId: pending.sessionId,
        chunkIndex: index,
        channelId: pending.channelId,
      });
      pending.nextIndex += 1;
    }
  }

  private async safeReply(message: DiscordMessageEnvelope, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch {
      this.logger.warn(
        { channelId: message.channelId },
        'Discord error response could not be sent',
      );
    }
  }

  private async tryReact(message: DiscordMessageEnvelope, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch {
      this.logger.debug({ channelId: message.channelId }, 'Discord reaction could not be updated');
    }
  }
}

function userError(category: ErrorCategory): string {
  if (category === 'timeout') return 'The Claude request timed out. Please try a narrower request.';
  if (category === 'cancelled') return 'The Claude request was cancelled.';
  if (category === 'overloaded') return 'The bot is busy. Please try again shortly.';
  if (category === 'mcp_unavailable' || category === 'claude_unavailable') {
    return 'The Odoo assistant is temporarily unavailable.';
  }
  return 'The request failed safely. Please try again.';
}
