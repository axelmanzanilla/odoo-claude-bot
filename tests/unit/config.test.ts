import { describe, expect, it } from 'vitest';
import { ConfigurationError, DEFAULT_TOOLS, parseConfig } from '../../src/config.js';

const validEnvironment = (): NodeJS.ProcessEnv => ({
  DISCORD_TOKEN: 'placeholder-token',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_ALLOWED_USER_IDS: '223456789012345678',
  DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
});

describe('parseConfig', () => {
  it('applies secure defaults', () => {
    const config = parseConfig(validEnvironment());
    expect(config.allowedChannelIds.size).toBe(0);
    expect(config.claudePermissionMode).toBe('dontAsk');
    expect(config.claudeAllowedTools).toEqual(DEFAULT_TOOLS);
    expect(config.maxConcurrentRequests).toBe(1);
    expect(config.odooWorkspace).toBe('/Users/axelmanzanilla/odoo/versions/19.0');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    'DISCORD_TOKEN',
    'DISCORD_APPLICATION_ID',
    'DISCORD_ALLOWED_USER_IDS',
    'DISCORD_ALLOWED_GUILD_IDS',
  ])('rejects a missing or empty %s', (name) => {
    const environment = validEnvironment();
    environment[name] = '';
    expect(() => parseConfig(environment)).toThrow(ConfigurationError);
  });

  it('rejects malformed IDs and relative privileged paths', () => {
    expect(() =>
      parseConfig({ ...validEnvironment(), DISCORD_ALLOWED_USER_IDS: 'alice' }),
    ).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), ODOO_WORKSPACE: './odoo' })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), CLAUDE_MCP_CONFIG: './mcp.json' })).toThrow();
  });

  it('rejects nonpositive limits and permission weakening', () => {
    expect(() => parseConfig({ ...validEnvironment(), CLAUDE_TIMEOUT_MS: '0' })).toThrow();
    expect(() => parseConfig({ ...validEnvironment(), MAX_CONCURRENT_REQUESTS: '-1' })).toThrow();
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_PERMISSION_MODE: 'bypassPermissions' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_ALLOWED_TOOLS: 'Read,Edit' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_ALLOWED_TOOLS: 'mcp__Odoo__delete' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_ALLOWED_TOOLS: 'mcp__Odoo__execute_kw' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_ALLOWED_TOOLS: 'mcp__Odoo__search_and_delete' }),
    ).toThrow();
  });

  it('requires the Odoo MCP by default and allows an explicit opt out', () => {
    expect(parseConfig(validEnvironment()).claudeRequireMcp).toBe(true);
    expect(
      parseConfig({ ...validEnvironment(), CLAUDE_REQUIRE_MCP: 'false' }).claudeRequireMcp,
    ).toBe(false);
    expect(parseConfig({ ...validEnvironment(), CLAUDE_REQUIRE_MCP: '0' }).claudeRequireMcp).toBe(
      false,
    );
    expect(() => parseConfig({ ...validEnvironment(), CLAUDE_REQUIRE_MCP: 'maybe' })).toThrow(
      ConfigurationError,
    );
  });

  it('permits read-only web tools without adding them to the default allowlist', () => {
    expect(DEFAULT_TOOLS).not.toContain('WebFetch');
    const config = parseConfig({
      ...validEnvironment(),
      CLAUDE_ALLOWED_TOOLS: 'Read,Glob,Grep,WebFetch,WebSearch',
    });
    expect(config.claudeAllowedTools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    expect(() =>
      parseConfig({ ...validEnvironment(), CLAUDE_ALLOWED_TOOLS: 'Read,WebFetch,Write' }),
    ).toThrow(ConfigurationError);
  });

  it('deduplicates allowlists and resolves the database path', () => {
    const config = parseConfig({
      ...validEnvironment(),
      DISCORD_ALLOWED_USER_IDS: '223456789012345678,223456789012345678',
      DATABASE_PATH: './data/test.sqlite3',
    });
    expect([...config.allowedUserIds]).toEqual(['223456789012345678']);
    expect(config.databasePath).toMatch(/\/data\/test\.sqlite3$/);
  });
});
