import type { AppConfig } from '../config.js';

export type DenialReason = 'bot' | 'webhook' | 'user' | 'guild' | 'channel' | 'unrelated';

export interface AuthorizationInput {
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly webhookId?: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly parentChannelId?: string;
  readonly mentionsBot: boolean;
  readonly botOwnsThread: boolean;
  readonly hasReplyReference: boolean;
}

export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };

export function authorize(
  input: AuthorizationInput,
  config: Pick<AppConfig, 'allowedUserIds' | 'allowedGuildIds' | 'allowedChannelIds'>,
): AuthorizationDecision {
  if (input.authorIsBot) return { allowed: false, reason: 'bot' };
  if (input.webhookId) return { allowed: false, reason: 'webhook' };
  if (!config.allowedUserIds.has(input.authorId)) return { allowed: false, reason: 'user' };
  if (!input.guildId || !config.allowedGuildIds.has(input.guildId)) {
    return { allowed: false, reason: 'guild' };
  }
  if (
    config.allowedChannelIds.size > 0 &&
    !config.allowedChannelIds.has(input.channelId) &&
    (!input.parentChannelId || !config.allowedChannelIds.has(input.parentChannelId))
  ) {
    return { allowed: false, reason: 'channel' };
  }
  if (!input.mentionsBot && !input.botOwnsThread && !input.hasReplyReference) {
    return { allowed: false, reason: 'unrelated' };
  }
  return { allowed: true };
}

export function normalizePrompt(content: string, applicationId: string): string {
  const mention = new RegExp(`<@!?${applicationId}>`, 'g');
  return content.replace(mention, '').trim();
}
