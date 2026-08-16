import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('createLogger', () => {
  it('redacts tokens and conversation bodies', () => {
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    const logger = createLogger('info', output);
    logger.info(
      {
        discordToken: 'discord-secret',
        prompt: 'private request',
        response: 'private answer',
        requestId: 42,
      },
      'completed',
    );
    expect(text).not.toContain('discord-secret');
    expect(text).not.toContain('private request');
    expect(text).not.toContain('private answer');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('42');
  });
});
