import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { ClaudeCliGateway } from '../../src/claude/cli-gateway.js';
import type { ProcessRunOptions } from '../../src/claude/process-runner.js';

function config() {
  return parseConfig({
    DISCORD_TOKEN: 'placeholder',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_ALLOWED_USER_IDS: '223456789012345678',
    DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
    ODOO_WORKSPACE: '/tmp/odoo',
    CLAUDE_MODEL: 'test-model',
    CLAUDE_MCP_CONFIG: '/tmp/mcp.json',
  });
}

describe('ClaudeCliGateway', () => {
  it.each([
    'plain text',
    'spaces "quotes" \'single\'',
    'new\nline; | > output',
    '`backticks` and $(touch /tmp/nope)',
    '--dangerously-skip-permissions',
    'Unicode 🦉 and **Discord Markdown**',
  ])('passes hostile prompt text as one inert argument: %s', async (prompt) => {
    let options: ProcessRunOptions | undefined;
    const runner = (input: ProcessRunOptions) => {
      options = input;
      return Promise.resolve({
        stdout: JSON.stringify({ session_id: 'new-session', result: 'answer' }),
        stderr: '',
      });
    };
    const gateway = new ClaudeCliGateway(config(), runner);
    await gateway.create(prompt);
    if (!options) throw new Error('runner was not called');
    expect(options.args.at(-1)).toBe(prompt);
    expect(options.args.filter((argument) => argument === prompt)).toHaveLength(1);
    expect(options.args.slice(0, options.args.lastIndexOf('--'))).not.toContain(
      '--dangerously-skip-permissions',
    );
  });

  it('uses resume and fork-session for replies without changing the parent', async () => {
    let options: ProcessRunOptions | undefined;
    const runner = (input: ProcessRunOptions) => {
      options = input;
      return Promise.resolve({
        stdout: JSON.stringify({
          session_id: 'fork-session',
          result: 'fork answer',
          total_cost_usd: 0.2,
          duration_ms: 50,
        }),
        stderr: '',
      });
    };
    const result = await new ClaudeCliGateway(config(), runner).forkAndContinue(
      'parent-session',
      'follow up',
    );
    if (!options) throw new Error('runner was not called');
    expect(options.args.slice(0, 3)).toEqual(['--resume', 'parent-session', '--fork-session']);
    expect(options.args.at(-1)).toBe('follow up');
    expect(result).toEqual({
      sessionId: 'fork-session',
      text: 'fork answer',
      totalCostUsd: 0.2,
      durationMs: 50,
    });
  });

  it.each(['', '{broken', '{}'])('rejects malformed or incomplete JSON output', async (stdout) => {
    const gateway = new ClaudeCliGateway(config(), () => Promise.resolve({ stdout, stderr: '' }));
    await expect(gateway.create('hello')).rejects.toMatchObject({
      category: 'invalid_output',
    });
  });
});
