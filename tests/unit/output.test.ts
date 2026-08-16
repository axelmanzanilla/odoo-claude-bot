import { describe, expect, it } from 'vitest';
import { splitDiscordOutput } from '../../src/discord/output.js';

describe('splitDiscordOutput', () => {
  it('returns short output unchanged', () => {
    expect(splitDiscordOutput('hello')).toEqual(['hello']);
  });

  it('splits without truncating ordinary text', () => {
    const input = 'word '.repeat(1_000);
    const chunks = splitDiscordOutput(input, 100);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(input);
  });

  it('balances fenced code blocks in every chunk', () => {
    const input = `before\n\`\`\`ts\n${'const value = 1;\n'.repeat(30)}\`\`\`\nafter`;
    const chunks = splitDiscordOutput(input, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
  });

  it('bounds an untrusted oversized fence language tag', () => {
    const chunks = splitDiscordOutput(`\`\`\`${'x'.repeat(500)}\ncode`, 80);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
  });
});
