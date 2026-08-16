import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ClaudeError } from './errors.js';
import type { ClaudeGateway, ClaudeTurnResult } from './gateway.js';
import { runProcess, type ProcessResult, type ProcessRunOptions } from './process-runner.js';

const claudeOutputSchema = z
  .object({
    session_id: z.string().min(1),
    result: z.string(),
    total_cost_usd: z.number().nonnegative().optional(),
    duration_ms: z.number().nonnegative().optional(),
  })
  .passthrough();

type Runner = (options: ProcessRunOptions) => Promise<ProcessResult>;

export class ClaudeCliGateway implements ClaudeGateway {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly config: AppConfig,
    private readonly runner: Runner = runProcess,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.environment = { ...environment };
  }

  async create(prompt: string, signal?: AbortSignal): Promise<ClaudeTurnResult> {
    return await this.invoke([...this.commonArgs(), '--', prompt], signal);
  }

  async forkAndContinue(
    parentSessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<ClaudeTurnResult> {
    return await this.invoke(
      ['--resume', parentSessionId, '--fork-session', ...this.commonArgs(), '--', prompt],
      signal,
    );
  }

  async checkReadiness(): Promise<void> {
    try {
      await access(this.config.odooWorkspace, constants.R_OK);
      await access(join(this.config.odooWorkspace, 'CLAUDE.md'), constants.R_OK);
    } catch {
      throw new ClaudeError('configuration', 'The Odoo workspace is not ready');
    }

    await this.run(['--version'], 10_000);
    if (!this.config.claudeRequireMcp) return;
    if (this.config.claudeMcpConfig) {
      await this.verifyMcpConfig(this.config.claudeMcpConfig);
      return;
    }

    const result = await this.run(['mcp', 'list'], 30_000);
    if (!result.stdout.toLowerCase().includes(this.config.claudeMcpServerName.toLowerCase())) {
      throw new ClaudeError('mcp_unavailable', 'The required Odoo MCP server is unavailable');
    }
  }

  private commonArgs(): string[] {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--setting-sources',
      this.config.claudeSettingSources,
      '--permission-mode',
      this.config.claudePermissionMode,
      '--allowedTools',
      this.config.claudeAllowedTools.join(','),
      '--max-budget-usd',
      String(this.config.claudeMaxBudgetUsd),
    ];
    if (this.config.claudeModel) args.push('--model', this.config.claudeModel);
    if (this.config.claudeMcpConfig)
      args.push('--mcp-config', this.config.claudeMcpConfig, '--strict-mcp-config');
    return args;
  }

  private async invoke(args: string[], signal?: AbortSignal): Promise<ClaudeTurnResult> {
    const output = await this.run(args, this.config.claudeTimeoutMs, signal);
    let decoded: unknown;
    try {
      decoded = JSON.parse(output.stdout);
    } catch {
      throw new ClaudeError('invalid_output', 'Claude returned malformed output');
    }
    const parsed = claudeOutputSchema.safeParse(decoded);
    if (!parsed.success)
      throw new ClaudeError('invalid_output', 'Claude returned incomplete output');
    return {
      sessionId: parsed.data.session_id,
      text: parsed.data.result,
      ...(parsed.data.total_cost_usd === undefined
        ? {}
        : { totalCostUsd: parsed.data.total_cost_usd }),
      ...(parsed.data.duration_ms === undefined ? {} : { durationMs: parsed.data.duration_ms }),
    };
  }

  private async run(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return await this.runner({
      executable: this.config.claudeBin,
      args,
      cwd: this.config.odooWorkspace,
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      environment: this.environment,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async verifyMcpConfig(path: string): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const config = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).parse(parsed);
      if (
        !Object.keys(config.mcpServers).some(
          (name) => name.toLowerCase() === this.config.claudeMcpServerName.toLowerCase(),
        )
      ) {
        throw new Error('missing server');
      }
    } catch {
      throw new ClaudeError('mcp_unavailable', 'The required Odoo MCP server is unavailable');
    }
  }
}
