export interface ClaudeTurnResult {
  readonly sessionId: string;
  readonly text: string;
  readonly totalCostUsd?: number;
  readonly durationMs?: number;
}

export interface ClaudeGateway {
  create(prompt: string, signal?: AbortSignal): Promise<ClaudeTurnResult>;
  forkAndContinue(
    parentSessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<ClaudeTurnResult>;
}
