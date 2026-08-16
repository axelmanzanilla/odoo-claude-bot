import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliGateway } from '../dist/claude/cli-gateway.js';
import { parseConfig } from '../dist/config.js';

const directory = mkdtempSync(join(tmpdir(), 'odoo-claude-bot-smoke-'));
try {
  const workspace = join(directory, 'odoo');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'CLAUDE.md'), '# fake workspace\n');
  const executable = join(directory, 'claude');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('fake 1.0');
else if (args[0] === 'mcp') console.log('Odoo: Connected');
else console.log(JSON.stringify({
  session_id: args.includes('--fork-session') ? 'fake-branch' : 'fake-root',
  result: 'mocked Odoo answer'
}));
`,
  );
  chmodSync(executable, 0o755);
  const config = parseConfig({
    DISCORD_TOKEN: 'placeholder-only',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_ALLOWED_USER_IDS: '223456789012345678',
    DISCORD_ALLOWED_GUILD_IDS: '323456789012345678',
    ODOO_WORKSPACE: workspace,
    CLAUDE_BIN: executable,
  });
  const gateway = new ClaudeCliGateway(config);
  await gateway.checkReadiness();
  const root = await gateway.create('estimate a task');
  const branch = await gateway.forkAndContinue(root.sessionId, 'remove optional scope');
  if (root.sessionId !== 'fake-root' || branch.sessionId !== 'fake-branch') {
    throw new Error('Fake session graph did not match expectations');
  }
  process.stdout.write('Fake create/fork smoke test passed.\n');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
