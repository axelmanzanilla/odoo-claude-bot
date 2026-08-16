import { describe, expect, it } from 'vitest';
import { RequestScheduler } from '../../src/queue/scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RequestScheduler', () => {
  it('enforces global concurrency and FIFO ordering', async () => {
    const scheduler = new RequestScheduler(1, 10);
    const first = deferred<void>();
    const order: string[] = [];
    const one = scheduler.schedule('1', 'a', async () => {
      order.push('one-start');
      await first.promise;
      order.push('one-end');
    });
    const two = scheduler.schedule('2', 'b', () => {
      order.push('two');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['one-start']);
    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(['one-start', 'one-end', 'two']);
  });

  it('serializes the same lineage even when other capacity is available', async () => {
    const scheduler = new RequestScheduler(2, 10);
    const release = deferred<void>();
    const order: string[] = [];
    const one = scheduler.schedule('1', 'root', async () => {
      order.push('root-1');
      await release.promise;
    });
    const two = scheduler.schedule('2', 'root', () => {
      order.push('root-2');
      return Promise.resolve();
    });
    const other = scheduler.schedule('3', 'other', () => {
      order.push('other');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['root-1', 'other']);
    release.resolve();
    await Promise.all([one, two, other]);
    expect(order.at(-1)).toBe('root-2');
  });

  it('cancels queued and running work and rejects overload', async () => {
    const scheduler = new RequestScheduler(1, 1);
    const active = scheduler.schedule(
      '1',
      'a',
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const queued = scheduler.schedule('2', 'b', () => Promise.resolve());
    await expect(scheduler.schedule('3', 'c', () => Promise.resolve())).rejects.toMatchObject({
      category: 'overloaded',
    });
    expect(scheduler.cancel('2')).toBe(true);
    await expect(queued).rejects.toMatchObject({ category: 'cancelled' });
    expect(scheduler.cancel('1')).toBe(true);
    await expect(active).rejects.toThrow('aborted');
  });

  it('stops intake and aborts active work during shutdown', async () => {
    const scheduler = new RequestScheduler(1, 2);
    const active = scheduler.schedule(
      '1',
      'root',
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('shutdown abort')));
        }),
    );
    const shutdown = scheduler.shutdown();
    await expect(active).rejects.toThrow('shutdown abort');
    await shutdown;
    await expect(scheduler.schedule('2', 'root', () => Promise.resolve())).rejects.toMatchObject({
      category: 'overloaded',
    });
    expect(scheduler.status()).toEqual({ accepting: false, active: 0, queued: 0 });
  });
});
