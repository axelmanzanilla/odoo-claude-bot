import { spawn } from 'node:child_process';
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const repositories = {
  odoo: 'https://github.com/odoo/odoo.git',
  documentation: 'https://github.com/odoo/documentation.git',
} as const;
type Repository = keyof typeof repositories;
const names = Object.keys(repositories) as Repository[];
const versionPattern = /^(?:\d{2}\.0|saas-\d{2}\.\d+)$/;

export function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a
    .replace(/^saas-/, '')
    .split('.')
    .map(Number);
  const [bMajor = 0, bMinor = 0] = b
    .replace(/^saas-/, '')
    .split('.')
    .map(Number);
  return bMajor - aMajor || bMinor - aMinor || a.localeCompare(b);
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let exceeded = false;
    let timedOut = false;
    let force: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
      force.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 600_000);
    child.stdout.on('data', (data: Buffer) => {
      if (output.length + data.length > 1024 * 1024) {
        exceeded = true;
        stop();
      } else output += data.toString('utf8');
    });
    // Drain diagnostics without exposing remote credentials or unbounded output.
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Git could not start. Install Git and retry.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (code !== 0 || exceeded || timedOut)
        reject(
          new Error(
            `Git ${args[0] ?? 'operation'} failed${timedOut ? ' (timeout)' : ''}. Check connectivity, branch availability, permissions, and local changes.`,
          ),
        );
      else resolveResult(output.trim());
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory())
    throw new Error(`Expected an ordinary directory: ${path}`);
}

export class WorkspaceManager {
  private constructor(
    readonly root: string,
    private readonly remotes: Record<Repository, string>,
  ) {}

  static async open(
    root: string,
    remotes: Record<Repository, string> = repositories,
  ): Promise<WorkspaceManager> {
    if (!isAbsolute(root)) throw new Error('--workspace must be an absolute host path.');
    await directory(root);
    return new WorkspaceManager(await realpath(root), remotes);
  }

  async run(
    command: 'init' | 'add' | 'update' | 'remove' | 'list',
    versions: string[],
  ): Promise<string> {
    for (const version of versions) {
      if (!versionPattern.test(version) || version.trim() !== version)
        throw new Error(`Invalid Odoo version: ${version}`);
    }
    if ((command === 'add' || command === 'remove') && versions.length === 0) {
      throw new Error(`${command} requires at least one version.`);
    }
    if ((command === 'list' || command === 'init') && versions.length)
      throw new Error(`${command} takes no versions.`);
    const lock = join(this.root, '.odoo-versions.lock');
    try {
      await mkdir(lock);
    } catch {
      throw new Error(
        'Workspace is locked. If no manager is running, remove .odoo-versions.lock and retry.',
      );
    }
    try {
      await directory(join(this.root, '.repositories'));
      await directory(join(this.root, 'versions'));
      const selected = [...new Set(versions.length ? versions : await this.versions())];
      for (const version of selected) {
        if (command === 'add') await this.add(version);
        if (command === 'update') await this.update(version);
        if (command === 'remove') await this.remove(version);
      }
      return await this.inventory();
    } catch (error) {
      // Publish partial progress when possible, preserving the original failure.
      try {
        await this.inventory();
      } catch {
        // Invalid/unmanaged paths must not be presented as installed sources.
      }
      throw error;
    } finally {
      await rmdir(lock);
    }
  }

  private repo(name: Repository): string {
    return join(this.root, '.repositories', `${name}.git`);
  }
  private checkout(version: string, name: Repository): string {
    return join(this.root, 'versions', version, name);
  }
  private ref(version: string): string {
    return `refs/heads/source/${version}`;
  }

  private async versions(): Promise<string[]> {
    return (await readdir(join(this.root, 'versions')))
      .filter((name) => versionPattern.test(name) && name.trim() === name)
      .sort(compareVersions);
  }

  private async prepare(name: Repository): Promise<void> {
    const repo = this.repo(name);
    if (!(await exists(repo))) {
      await git(this.root, ['init', '--bare', repo]);
      await git(repo, ['remote', 'add', 'origin', this.remotes[name]]);
    }
    if (
      !(await lstat(repo)).isDirectory() ||
      (await git(repo, ['rev-parse', '--is-bare-repository'])) !== 'true'
    ) {
      throw new Error(`Invalid managed repository: ${name}`);
    }
  }

  private async fetch(version: string, name: Repository): Promise<void> {
    await git(this.repo(name), [
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      'origin',
      `+refs/heads/${version}:${this.ref(version)}`,
    ]);
  }

  private async assertManaged(version: string, name: Repository, clean = false): Promise<void> {
    const path = this.checkout(version, name);
    if (
      !(await lstat(join(this.root, 'versions', version))).isDirectory() ||
      !(await lstat(path)).isDirectory()
    ) {
      throw new Error('Refusing a symlink or non-directory worktree.');
    }
    const common = await git(path, ['rev-parse', '--git-common-dir']);
    if ((await realpath(resolve(path, common))) !== (await realpath(this.repo(name)))) {
      throw new Error(`Refusing an unmanaged checkout: ${version}/${name}`);
    }
    if (clean) {
      if (
        (await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored'])) !== ''
      ) {
        throw new Error(
          `Local changes in ${version}/${name}; preserve or remove them manually first.`,
        );
      }
      // Detached source snapshots must not contain operator commits or a checked-out branch.
      if (
        (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== 'HEAD' ||
        (await git(path, ['rev-parse', 'HEAD'])) !==
          (await git(this.repo(name), ['rev-parse', this.ref(version)]))
      ) {
        throw new Error(`Changed HEAD in ${version}/${name}; refusing to discard operator work.`);
      }
    }
  }

  private async add(version: string): Promise<void> {
    await directory(join(this.root, 'versions', version));
    for (const name of names) {
      if (await exists(this.checkout(version, name))) {
        await this.assertManaged(version, name);
        continue;
      }
      await this.prepare(name);
      await this.fetch(version, name);
      await git(this.repo(name), [
        'worktree',
        'add',
        '--detach',
        this.checkout(version, name),
        this.ref(version),
      ]);
    }
  }

  private async update(version: string): Promise<void> {
    for (const name of names) await this.assertManaged(version, name, true);
    for (const name of names) {
      // Fetch into FETCH_HEAD first: a failed checkout keeps the previous source ref.
      await git(this.repo(name), [
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        'origin',
        `refs/heads/${version}`,
      ]);
      const commit = await git(this.repo(name), ['rev-parse', 'FETCH_HEAD']);
      await git(this.checkout(version, name), ['checkout', '--detach', commit]);
      await git(this.repo(name), ['update-ref', this.ref(version), commit]);
    }
  }

  private async remove(version: string): Promise<void> {
    const parent = join(this.root, 'versions', version);
    if (!(await exists(parent))) return;
    const installed: Repository[] = [];
    if (!(await lstat(parent)).isDirectory())
      throw new Error('Refusing a symlink version directory.');
    if ((await readdir(parent)).some((name) => !names.includes(name as Repository))) {
      throw new Error(`Extra files in versions/${version}; preserve them manually first.`);
    }
    for (const name of names) {
      if (await exists(this.checkout(version, name))) {
        await this.assertManaged(version, name, true);
        installed.push(name);
      }
    }
    for (const name of installed) {
      await git(this.repo(name), ['worktree', 'remove', this.checkout(version, name)]);
      await git(this.repo(name), ['update-ref', '-d', this.ref(version)]);
    }
    await rmdir(parent);
  }

  private async inventory(): Promise<string> {
    const rows = [
      '# Installed Odoo sources',
      '',
      'Generated by the host operator. Re-read this file on every request, including resumed sessions.',
      'Use the explicitly requested version, or the newest installed Odoo source when none is specified in the current request.',
      'Missing paths mean unavailable source. Never substitute for an explicitly requested version.',
      '',
      '| Version | Repository | Commit | Path |',
      '| --- | --- | --- | --- |',
    ];
    let newest: string | undefined;
    for (const version of await this.versions()) {
      for (const name of names) {
        if (!(await exists(this.checkout(version, name)))) continue;
        await this.assertManaged(version, name);
        const commit = await git(this.checkout(version, name), ['rev-parse', 'HEAD']);
        if (name === 'odoo') newest ??= version;
        rows.push(`| ${version} | ${name} | ${commit} | versions/${version}/${name}/ |`);
      }
    }
    rows.push(
      '',
      newest
        ? `Newest installed Odoo source: ${newest}.`
        : 'No Odoo source installed. Source inspection is unavailable until the operator adds a version.',
    );
    const content = `${rows.join('\n')}\n`;
    const temp = join(this.root, '.VERSIONS.md.tmp');
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, join(this.root, 'VERSIONS.md'));
    return content;
  }
}

export async function installInstructions(root: string, template: string): Promise<void> {
  const target = join(root, 'CLAUDE.md');
  if (!(await exists(target)))
    await writeFile(target, await readFile(template, 'utf8'), { flag: 'wx' });
}
