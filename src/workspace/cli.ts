import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installInstructions, WorkspaceManager } from './manager.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { workspace: { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, ...versions] = positionals;
  if (values.help) {
    console.log(
      'npm run versions -- <init|add|list|update|remove> [versions...] --workspace /absolute/host/path',
    );
  } else {
    if (!values.workspace || !['init', 'add', 'list', 'update', 'remove'].includes(command ?? '')) {
      throw new Error(
        'Usage: npm run versions -- <init|add|list|update|remove> [versions...] --workspace /absolute/host/path',
      );
    }
    const manager = await WorkspaceManager.open(values.workspace);
    console.log(
      await manager.run(command as 'init' | 'add' | 'list' | 'update' | 'remove', versions),
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
