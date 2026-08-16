import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliGateway } from '../../src/claude/cli-gateway.js';
import { parseConfig } from '../../src/config.js';

const directories: string[] = [];

function fixture(mode = 'success') {
  const directory = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  directories.push(directory);
  const workspace = join(directory, 'odoo');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'CLAUDE.md'), '# fixture');
  const executable = join(directory, 'claude');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.229'); process.exit(0); }
if (args[0] === 'mcp') { console.log('Odoo: Connected'); process.exit(0); }
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000); }
else if (${JSON.stringify(mode)} === 'fail') { console.error('secret detail'); process.exit(2); }
else {
  if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd() }));
  const fork = args.includes('--fork-session');
  console.log(JSON.stringify({ session_id: fork ? 'branch-session' : 'root-session', result: 'fake answer' }));
}
`,
  );
  chmodSync(executable, 0o755);
  const record = join(directory, 'record.json');
  const config = parseConfig({
    DISCORD_TOKEN: 'placeholder',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_ALLOWED_USER_IDS: '223456789012345678',
    DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
    ODOO_WORKSPACE: workspace,
    CLAUDE_BIN: executable,
    CLAUDE_TIMEOUT_MS: mode === 'hang' ? '50' : '5000',
  });
  return {
    gateway: new ClaudeCliGateway(config, undefined, { ...process.env, FAKE_RECORD: record }),
    executable,
    record,
    workspace,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('fake Claude CLI integration', () => {
  it('creates and forks distinct sessions using the fixed workspace', async () => {
    const { gateway } = fixture();
    await expect(gateway.checkReadiness()).resolves.toBeUndefined();
    const root = await gateway.create('hello');
    const branch = await gateway.forkAndContinue(root.sessionId, 'follow up');
    expect(root.sessionId).toBe('root-session');
    expect(branch.sessionId).toBe('branch-session');
  });

  it('returns typed errors for nonzero exits and timeouts', async () => {
    await expect(fixture('fail').gateway.create('hello')).rejects.toMatchObject({
      category: 'process_failed',
    });
    await expect(fixture('hang').gateway.create('hello')).rejects.toMatchObject({
      category: 'timeout',
    });
  });

  it('supports cancellation', async () => {
    const { gateway } = fixture('hang');
    const controller = new AbortController();
    const promise = gateway.create('hello', controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ category: 'cancelled' });
  });

  it('fails readiness for a missing workspace instruction or MCP server', async () => {
    const missingInstructions = fixture();
    rmSync(join(missingInstructions.workspace, 'CLAUDE.md'));
    await expect(missingInstructions.gateway.checkReadiness()).rejects.toMatchObject({
      category: 'configuration',
    });

    const missingMcp = fixture();
    const config = parseConfig({
      DISCORD_TOKEN: 'placeholder',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOWED_USER_IDS: '223456789012345678',
      DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
      ODOO_WORKSPACE: missingMcp.workspace,
      CLAUDE_BIN: missingMcp.executable,
      CLAUDE_MCP_SERVER_NAME: 'MissingServer',
    });
    await expect(new ClaudeCliGateway(config).checkReadiness()).rejects.toMatchObject({
      category: 'mcp_unavailable',
    });
  });

  it('reports a missing executable without exposing process details', async () => {
    const missing = fixture();
    const config = parseConfig({
      DISCORD_TOKEN: 'placeholder',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOWED_USER_IDS: '223456789012345678',
      DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
      ODOO_WORKSPACE: missing.workspace,
      CLAUDE_BIN: join(missing.workspace, 'not-installed'),
    });
    await expect(new ClaudeCliGateway(config).create('hello')).rejects.toMatchObject({
      category: 'claude_unavailable',
    });
  });
});
