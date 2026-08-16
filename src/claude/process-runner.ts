import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ClaudeError } from './errors.js';

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
}

export async function runProcess(options: ProcessRunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new ClaudeError('cancelled', 'Claude request was cancelled');

  return await new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.environment,
      });
    } catch {
      reject(new ClaudeError('claude_unavailable', 'Claude executable is unavailable'));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminationCategory: 'timeout' | 'cancelled' | undefined;

    const finish = (error?: ClaudeError, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const terminate = (category: 'timeout' | 'cancelled') => {
      if (settled || terminationCategory) return;
      terminationCategory = category;
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 2_000);
      forceTimer.unref();
    };

    const abort = () => terminate('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timeout.unref();

    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = target === 'stdout' ? stdout : stderr;
      if (current.length + chunk.length > options.maxOutputBytes) {
        terminate('cancelled');
        finish(new ClaudeError('invalid_output', 'Claude output exceeded the safe size limit'));
        return;
      }
      if (target === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));

    child.once('error', () =>
      finish(new ClaudeError('claude_unavailable', 'Claude executable is unavailable')),
    );
    child.once('close', (code, signal) => {
      if (terminationCategory) {
        finish(
          new ClaudeError(
            terminationCategory,
            terminationCategory === 'timeout'
              ? 'Claude request timed out'
              : 'Claude request was cancelled',
          ),
        );
      } else if (code !== 0) {
        finish(
          new ClaudeError(
            'process_failed',
            `Claude exited unsuccessfully (${code ?? signal ?? 'unknown'})`,
          ),
        );
      } else {
        finish(undefined, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      }
    });
  });
}
