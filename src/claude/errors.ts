import type { ErrorCategory } from '../domain/types.js';

export class ClaudeError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

export function safeClaudeError(error: unknown): ClaudeError {
  if (error instanceof ClaudeError) return error;
  return new ClaudeError('unknown', 'Claude request failed');
}
