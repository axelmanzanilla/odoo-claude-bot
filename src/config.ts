import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__Odoo__search', 'mcp__Odoo__read'] as const;
const SNOWFLAKE = /^\d{17,20}$/;
const BUILTIN_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const READ_ONLY_MCP_TOOL = /(?:^|_)(?:read|search|get|list|find|query|lookup|fetch)(?:$|_)/i;
const MUTATING_MCP_TOOL =
  /(?:^|_)(?:add|call|create|delete|execute|mutate|post|remove|send|set|unlink|update|write)(?:$|_)/i;

function isReadOnlyTool(tool: string): boolean {
  if (BUILTIN_READ_TOOLS.has(tool)) return true;
  if (!tool.startsWith('mcp__')) return false;
  const name = tool.split('__').at(-1);
  return Boolean(name && READ_ONLY_MCP_TOOL.test(name) && !MUTATING_MCP_TOOL.test(name));
}

const positiveInteger = (fallback: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((value, context) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        context.addIssue({ code: 'custom', message: 'must be a positive integer' });
        return z.NEVER;
      }
      return parsed;
    });

const positiveNumber = (fallback: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((value, context) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        context.addIssue({ code: 'custom', message: 'must be a positive number' });
        return z.NEVER;
      }
      return parsed;
    });

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const snowflakeList = commaList.pipe(
  z
    .array(z.string().regex(SNOWFLAKE, 'must contain Discord snowflakes'))
    .transform((items) => [...new Set(items)]),
);

const absolutePath = z.string().min(1).refine(isAbsolute, 'must be an absolute path');
const optionalAbsolutePath = z
  .string()
  .default('')
  .transform((value) => value.trim() || undefined)
  .refine((value) => value === undefined || isAbsolute(value), 'must be an absolute path');

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(SNOWFLAKE),
  DISCORD_ALLOWED_USER_IDS: snowflakeList.refine((items) => items.length > 0, 'must not be empty'),
  DISCORD_ALLOWED_GUILD_IDS: snowflakeList.refine((items) => items.length > 0, 'must not be empty'),
  DISCORD_ALLOWED_CHANNEL_IDS: z.string().default('').pipe(snowflakeList),
  ODOO_WORKSPACE: absolutePath.default('/Users/axelmanzanilla/odoo/versions/19.0'),
  CLAUDE_BIN: z.string().trim().min(1).default('claude'),
  CLAUDE_MODEL: z
    .string()
    .default('')
    .transform((value) => value.trim() || undefined),
  CLAUDE_MCP_CONFIG: optionalAbsolutePath,
  CLAUDE_MCP_SERVER_NAME: z.string().trim().min(1).default('Odoo'),
  CLAUDE_SETTING_SOURCES: z
    .string()
    .default('user,project,local')
    .refine((value) => {
      const sources = value.split(',');
      return (
        sources.length > 0 &&
        sources.every((source) => ['user', 'project', 'local'].includes(source))
      );
    }, 'must contain only user, project, and local'),
  CLAUDE_PERMISSION_MODE: z.literal('dontAsk').default('dontAsk'),
  CLAUDE_ALLOWED_TOOLS: z
    .string()
    .default(DEFAULT_TOOLS.join(','))
    .pipe(commaList)
    .refine((tools) => tools.length > 0, 'must not be empty')
    .refine(
      (tools) => tools.every(isReadOnlyTool),
      'contains a tool that is not explicitly read-only',
    ),
  CLAUDE_TIMEOUT_MS: positiveInteger(900_000),
  CLAUDE_MAX_BUDGET_USD: positiveNumber(5),
  MAX_CONCURRENT_REQUESTS: positiveInteger(1),
  MAX_QUEUED_REQUESTS: positiveInteger(50),
  DATABASE_PATH: z.string().trim().min(1).default('./data/bot.sqlite3'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SHUTDOWN_GRACE_MS: positiveInteger(30_000),
});

export interface AppConfig {
  readonly discordToken: string;
  readonly discordApplicationId: string;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly allowedGuildIds: ReadonlySet<string>;
  readonly allowedChannelIds: ReadonlySet<string>;
  readonly odooWorkspace: string;
  readonly claudeBin: string;
  readonly claudeModel?: string;
  readonly claudeMcpConfig?: string;
  readonly claudeMcpServerName: string;
  readonly claudeSettingSources: string;
  readonly claudePermissionMode: 'dontAsk';
  readonly claudeAllowedTools: readonly string[];
  readonly claudeTimeoutMs: number;
  readonly claudeMaxBudgetUsd: number;
  readonly maxConcurrentRequests: number;
  readonly maxQueuedRequests: number;
  readonly databasePath: string;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly shutdownGraceMs: number;
}

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function parseConfig(environment: NodeJS.ProcessEnv): Readonly<AppConfig> {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) throw new ConfigurationError(result.error);
  const value = result.data;

  return Object.freeze({
    discordToken: value.DISCORD_TOKEN,
    discordApplicationId: value.DISCORD_APPLICATION_ID,
    allowedUserIds: new Set(value.DISCORD_ALLOWED_USER_IDS),
    allowedGuildIds: new Set(value.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: new Set(value.DISCORD_ALLOWED_CHANNEL_IDS),
    odooWorkspace: value.ODOO_WORKSPACE,
    claudeBin: value.CLAUDE_BIN,
    ...(value.CLAUDE_MODEL === undefined ? {} : { claudeModel: value.CLAUDE_MODEL }),
    ...(value.CLAUDE_MCP_CONFIG === undefined ? {} : { claudeMcpConfig: value.CLAUDE_MCP_CONFIG }),
    claudeMcpServerName: value.CLAUDE_MCP_SERVER_NAME,
    claudeSettingSources: value.CLAUDE_SETTING_SOURCES,
    claudePermissionMode: value.CLAUDE_PERMISSION_MODE,
    claudeAllowedTools: Object.freeze([...value.CLAUDE_ALLOWED_TOOLS]),
    claudeTimeoutMs: value.CLAUDE_TIMEOUT_MS,
    claudeMaxBudgetUsd: value.CLAUDE_MAX_BUDGET_USD,
    maxConcurrentRequests: value.MAX_CONCURRENT_REQUESTS,
    maxQueuedRequests: value.MAX_QUEUED_REQUESTS,
    databasePath: resolve(value.DATABASE_PATH),
    logLevel: value.LOG_LEVEL,
    shutdownGraceMs: value.SHUTDOWN_GRACE_MS,
  });
}

export { DEFAULT_TOOLS };
