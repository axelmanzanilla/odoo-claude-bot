import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  git,
  installInstructions,
  WorkspaceManager,
} from '../../src/workspace/manager.js';

let temp: string;
let root: string;
let remote: string;
let manager: WorkspaceManager;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'odoo-versions-'));
  root = join(temp, 'workspace with spaces');
  remote = join(temp, 'remote');
  await mkdir(remote);
  await git(remote, ['init']);
  await git(remote, ['config', 'user.name', 'Test']);
  await git(remote, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(remote, 'source.txt'), 'original');
  await git(remote, ['add', '.']);
  await git(remote, ['commit', '-m', 'initial']);
  for (const branch of ['18.0', '19.0', 'saas-19.3', 'saas-19.4'])
    await git(remote, ['branch', branch]);
  manager = await WorkspaceManager.open(root, { odoo: remote, documentation: remote });
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('operator version manager with real local Git remotes', () => {
  it('initializes without repositories and selects the newest installed code as versions change', async () => {
    expect(await manager.run('init', [])).toContain('No Odoo source installed.');
    expect(await readdir(join(root, '.repositories'))).toEqual([]);
    expect(await readdir(join(root, 'versions'))).toEqual([]);
    for (const branch of ['16.0', '20.0']) await git(remote, ['branch', branch]);
    expect(await manager.run('add', ['16.0'])).toContain('Newest installed Odoo source: 16.0.');
    expect(await manager.run('add', ['saas-19.4'])).toContain(
      'Newest installed Odoo source: saas-19.4.',
    );
    expect(await manager.run('add', ['20.0'])).toContain('Newest installed Odoo source: 20.0.');
    expect(await manager.run('remove', ['20.0'])).toContain(
      'Newest installed Odoo source: saas-19.4.',
    );
    await manager.run('remove', ['saas-19.4']);
    expect(await manager.run('remove', ['16.0'])).toContain('No Odoo source installed.');
  }, 15_000);

  it('orders major and SaaS minor versions numerically, not by name or download order', () => {
    expect(
      ['saas-19.4', '16.0', '20.0', 'saas-19.10', '19.0', 'saas-19.3'].sort(compareVersions),
    ).toEqual(['20.0', 'saas-19.10', 'saas-19.4', 'saas-19.3', '19.0', '16.0']);
  });

  it('does not count documentation-only checkouts as installed Odoo code', async () => {
    await manager.run('add', ['19.0']);
    await git(join(root, '.repositories/odoo.git'), [
      'worktree',
      'remove',
      join(root, 'versions/19.0/odoo'),
    ]);
    const inventory = await manager.run('list', []);
    expect(inventory).toContain('versions/19.0/documentation/');
    expect(inventory).toContain('No Odoo source installed.');
  });

  it('adds four versions, shares objects, lists exact commits and removes only the selected version', async () => {
    await manager.run('add', ['18.0', '19.0', 'saas-19.3', 'saas-19.4']);
    const inventory = await manager.run('list', []);
    expect(inventory).toContain('versions/saas-19.4/documentation/');
    const checkout = join(root, 'versions/19.0/odoo');
    expect(await git(checkout, ['rev-parse', '--git-common-dir'])).toContain(
      '.repositories/odoo.git',
    );
    await manager.run('add', ['19.0']);
    await manager.run('remove', ['18.0']);
    await manager.run('remove', ['18.0']);
    expect(await manager.run('list', [])).not.toContain('| 18.0 |');
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('original');
  });

  it('updates a selected snapshot and retains other versions, then updates all', async () => {
    await manager.run('add', ['18.0', '19.0']);
    await git(remote, ['checkout', '19.0']);
    await writeFile(join(remote, 'source.txt'), 'updated');
    await git(remote, ['commit', '-am', 'update']);
    await manager.run('update', ['19.0']);
    expect(await readFile(join(root, 'versions/19.0/odoo/source.txt'), 'utf8')).toBe('updated');
    expect(await readFile(join(root, 'versions/18.0/odoo/source.txt'), 'utf8')).toBe('original');
    await manager.run('update', []);
  });

  it('refuses dirty worktrees before deleting or updating either repository', async () => {
    await manager.run('add', ['19.0']);
    await writeFile(join(root, 'versions/19.0/documentation/local.txt'), 'keep me');
    await expect(manager.run('remove', ['19.0'])).rejects.toThrow('Local changes');
    await expect(manager.run('update', ['19.0'])).rejects.toThrow('Local changes');
    expect(await readFile(join(root, 'versions/19.0/odoo/source.txt'), 'utf8')).toBe('original');
  });

  it('refuses operator commits, extra files, symlinks and unmanaged checkouts', async () => {
    await manager.run('add', ['19.0']);
    const checkout = join(root, 'versions/19.0/odoo');
    await git(checkout, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'local',
    ]);
    await expect(manager.run('remove', ['19.0'])).rejects.toThrow('Changed HEAD');
    await writeFile(join(root, 'versions/19.0/custom.txt'), 'keep');
    await expect(manager.run('remove', ['19.0'])).rejects.toThrow('Extra files');
    await symlink(remote, join(root, 'versions/18.0'));
    await expect(manager.run('add', ['18.0'])).rejects.toThrow();
    await rm(join(root, 'versions/18.0'));
    await mkdir(join(root, 'versions/18.0/odoo'), { recursive: true });
    await git(root, ['init', join(root, 'versions/18.0/odoo')]);
    await expect(manager.run('remove', ['18.0'])).rejects.toThrow('unmanaged');
  });

  it('rejects invalid names and missing branches without running shell content', async () => {
    for (const version of ['../19.0', '--help', '19.0;touch pwned', '$(touch pwned)', '19.0\n']) {
      await expect(manager.run('add', [version])).rejects.toThrow('Invalid');
    }
    await expect(manager.run('add', ['saas-99.9'])).rejects.toThrow('Git fetch failed');
    expect(await manager.run('list', [])).not.toContain('| saas-99.9 |');
    await manager.run('remove', ['saas-99.9']);
    await expect(WorkspaceManager.open('relative')).rejects.toThrow('absolute');
  });

  it('records partial success after a missing documentation branch and supports retry', async () => {
    const docs = join(temp, 'docs');
    await git(temp, ['clone', '--bare', remote, docs]);
    await git(docs, ['branch', '-D', 'saas-19.4']);
    manager = await WorkspaceManager.open(root, { odoo: remote, documentation: docs });
    await expect(manager.run('add', ['saas-19.4'])).rejects.toThrow('Git fetch failed');
    const partial = await readFile(join(root, 'VERSIONS.md'), 'utf8');
    expect(partial).toContain('versions/saas-19.4/odoo/');
    expect(partial).not.toContain('versions/saas-19.4/documentation/');
    await git(docs, ['branch', 'saas-19.4', '19.0']);
    expect(await manager.run('add', ['saas-19.4'])).toContain('versions/saas-19.4/documentation/');
  });

  it('preserves existing instructions and serializes operator mutations', async () => {
    const template = join(temp, 'template.md');
    await writeFile(template, 'template');
    await installInstructions(root, template);
    await writeFile(join(root, 'CLAUDE.md'), 'custom instructions');
    await installInstructions(root, template);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('custom instructions');
    await mkdir(join(root, '.odoo-versions.lock'));
    await expect(manager.run('add', ['19.0'])).rejects.toThrow('locked');
  });
});
