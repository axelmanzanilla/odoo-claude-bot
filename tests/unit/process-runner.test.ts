import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/claude/process-runner.js';

describe('runProcess', () => {
  it('enforces independent bounded stdout and stderr collection', async () => {
    await expect(
      runProcess({
        executable: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(1000))"],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ category: 'invalid_output' });
  });

  it('rejects an already-aborted request before spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess({
        executable: process.execPath,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxOutputBytes: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ category: 'cancelled' });
  });
});
