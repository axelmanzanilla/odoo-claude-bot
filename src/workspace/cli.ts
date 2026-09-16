import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installInstructions, WorkspaceManager } from './manager.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      help: { type: 'boolean' },
      enterprise: { type: 'boolean' },
    },
  });
  const [command, ...versions] = positionals;
  if (values.help) {
    console.log(
      'npm run versions -- <init|add|list|update|remove> [versions...] --workspace /absolute/host/path\n--enterprise: with add, include Enterprise; with remove, remove only Enterprise.\nupdate refreshes all installed repositories; no downloads happen during init.',
    );
  } else {
    if (!values.workspace || !['init', 'add', 'list', 'update', 'remove'].includes(command ?? '')) {
      throw new Error(
        'Usage: npm run versions -- <init|add|list|update|remove> [versions...] --workspace /absolute/host/path',
      );
    }
    const manager = await WorkspaceManager.open(values.workspace);
    console.log(
      await manager.run(command as 'init' | 'add' | 'list' | 'update' | 'remove', versions, {
        enterprise: values.enterprise ?? false,
      }),
    );
    await installInstructions(
      manager.root,
      fileURLToPath(new URL('../../deploy/workspace-CLAUDE.md.example', import.meta.url)),
    );
    console.log(
      'Existing CLAUDE.md is preserved. For migration, merge the multi-version template from deploy/workspace-CLAUDE.md.example.',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Workspace operation failed.');
  process.exitCode = 1;
}
