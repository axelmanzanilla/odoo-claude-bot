export const REQUEST_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ERROR_CATEGORIES = [
  'configuration',
  'database',
  'claude_unavailable',
  'mcp_unavailable',
  'timeout',
  'cancelled',
  'invalid_output',
  'process_failed',
  'discord_api',
  'overloaded',
  'unknown',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface IncomingRequest {
  readonly userMessageId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId: string;
  readonly referencedMessageId?: string;
  readonly parentSessionId?: string;
}

export interface StoredRequest extends IncomingRequest {
  readonly id: number;
  readonly status: RequestStatus;
  readonly claudeSessionId?: string;
  readonly rootSessionId?: string;
  readonly durationMs?: number;
  readonly totalCostUsd?: number;
  readonly errorCategory?: ErrorCategory;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionMapping {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly rootSessionId: string;
  readonly requestId: number;
}
