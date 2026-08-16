import { describe, expect, it } from 'vitest';
import {
  authorize,
  normalizePrompt,
  type AuthorizationInput,
} from '../../src/discord/authorization.js';

const config = {
  allowedUserIds: new Set(['100000000000000001']),
  allowedGuildIds: new Set(['200000000000000001']),
  allowedChannelIds: new Set(['300000000000000001']),
};
const allowed: AuthorizationInput = {
  authorId: '100000000000000001',
  authorIsBot: false,
  guildId: '200000000000000001',
  channelId: '300000000000000001',
  mentionsBot: true,
  botOwnsThread: false,
  hasReplyReference: false,
};

describe('authorize', () => {
  it('allows an explicitly listed user, guild, and channel', () => {
    expect(authorize(allowed, config)).toEqual({ allowed: true });
  });

  it.each([
    [{ authorIsBot: true }, 'bot'],
    [{ webhookId: 'webhook' }, 'webhook'],
    [{ authorId: '900000000000000001' }, 'user'],
    [{ guildId: '900000000000000001' }, 'guild'],
    [{ channelId: '900000000000000001' }, 'channel'],
    [{ mentionsBot: false }, 'unrelated'],
  ] as const)('denies %j as %s', (change, reason) => {
    expect(authorize({ ...allowed, ...change }, config)).toEqual({ allowed: false, reason });
  });

  it('denies direct messages without a guild', () => {
    const directMessage: AuthorizationInput = {
      authorId: allowed.authorId,
      authorIsBot: allowed.authorIsBot,
      channelId: allowed.channelId,
      mentionsBot: allowed.mentionsBot,
      botOwnsThread: allowed.botOwnsThread,
      hasReplyReference: allowed.hasReplyReference,
    };
    expect(authorize(directMessage, config)).toEqual({ allowed: false, reason: 'guild' });
  });

  it('allows a thread whose parent is listed and messages in bot-owned threads', () => {
    expect(
      authorize(
        {
          ...allowed,
          channelId: '400000000000000001',
          parentChannelId: '300000000000000001',
          mentionsBot: false,
          botOwnsThread: true,
        },
        config,
      ),
    ).toEqual({ allowed: true });
  });

  it('allows a reply as a preliminary eligibility signal', () => {
    expect(authorize({ ...allowed, mentionsBot: false, hasReplyReference: true }, config)).toEqual({
      allowed: true,
    });
  });

  it('fails closed when required allowlists are empty', () => {
    expect(
      authorize(allowed, { ...config, allowedUserIds: new Set(), allowedGuildIds: new Set() }),
    ).toEqual({ allowed: false, reason: 'user' });
  });
});

describe('normalizePrompt', () => {
  it('removes only exact bot mentions and surrounding whitespace', () => {
    expect(
      normalizePrompt(
        '  <@123456789012345678> keep <@999999999999999999> text  ',
        '123456789012345678',
      ),
    ).toBe('keep <@999999999999999999> text');
    expect(normalizePrompt('<@!123456789012345678>\nhello', '123456789012345678')).toBe('hello');
  });
});
