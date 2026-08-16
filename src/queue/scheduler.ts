import { ClaudeError } from '../claude/errors.js';

interface QueueItem<T> {
  readonly id: string;
  readonly lineageKey: string;
  readonly task: (signal: AbortSignal) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly controller: AbortController;
}

export interface SchedulerStatus {
  readonly accepting: boolean;
  readonly active: number;
  readonly queued: number;
}

export class RequestScheduler {
  private readonly queue: Array<QueueItem<unknown>> = [];
  private readonly activeLineages = new Set<string>();
  private readonly active = new Map<string, QueueItem<unknown>>();
  private readonly activePromises = new Map<string, Promise<void>>();
  private accepting = true;

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {}

  schedule<T>(
    id: string,
    lineageKey: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      !this.accepting ||
      this.queue.length >= this.maxQueued ||
      this.active.has(id) ||
      this.queue.some((item) => item.id === id)
    ) {
      return Promise.reject(
        new ClaudeError('overloaded', 'The request scheduler is not accepting work'),
      );
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        lineageKey,
        task,
        resolve,
        reject,
        controller: new AbortController(),
      } as QueueItem<unknown>);
      this.drain();
    });
  }

  cancel(id: string): boolean {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex !== -1) {
      const [item] = this.queue.splice(queuedIndex, 1);
      item?.reject(new ClaudeError('cancelled', 'The queued request was cancelled'));
      return true;
    }
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  status(): SchedulerStatus {
    return { accepting: this.accepting, active: this.active.size, queued: this.queue.length };
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const item of this.queue.splice(0)) {
      item.reject(new ClaudeError('cancelled', 'The queued request was cancelled'));
    }
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.activePromises.values()]);
  }

  private drain(): void {
    while (this.active.size < this.concurrency) {
      const index = this.queue.findIndex((item) => !this.activeLineages.has(item.lineageKey));
      if (index === -1) return;
      const [item] = this.queue.splice(index, 1);
      if (!item) return;
      this.active.set(item.id, item);
      this.activeLineages.add(item.lineageKey);
      const execution = item
        .task(item.controller.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active.delete(item.id);
          this.activePromises.delete(item.id);
          this.activeLineages.delete(item.lineageKey);
          this.drain();
        });
      this.activePromises.set(item.id, execution);
    }
  }
}
