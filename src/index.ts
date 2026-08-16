import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { Events } from 'discord.js';
import { ClaudeCliGateway } from './claude/cli-gateway.js';
import { ClaudeError } from './claude/errors.js';
import { parseConfig } from './config.js';
import { createDiscordClient, registerMessageHandler } from './discord/client.js';
import { DiscordMessageHandler } from './discord/handler.js';
import { ReadinessState } from './health.js';
import { createLogger } from './logger.js';
import { openDatabase } from './persistence/database.js';
import { BotRepository } from './persistence/repository.js';
import { RequestScheduler } from './queue/scheduler.js';

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch {
    process.stderr.write('Fatal: invalid bot configuration.\n');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  const readiness = new ReadinessState();
  readiness.set('configuration', 'ready');
  let database;
  try {
    database = openDatabase(config.databasePath);
    readiness.set('database', 'ready');
  } catch {
    logger.fatal({ category: 'database' }, 'Database startup failed');
    process.exitCode = 1;
    return;
  }

  const repository = new BotRepository(database);
  const claude = new ClaudeCliGateway(config);
  const scheduler = new RequestScheduler(config.maxConcurrentRequests, config.maxQueuedRequests);
  const client = createDiscordClient();

  const mcpIdleStatus = config.claudeRequireMcp ? 'unhealthy' : 'disabled';
  const refreshClaudeReadiness = async () => {
    try {
      await claude.checkReadiness();
      readiness.set('claude', 'ready');
      readiness.set('mcp', config.claudeRequireMcp ? 'ready' : 'disabled');
    } catch (error) {
      if (error instanceof ClaudeError && error.category === 'mcp_unavailable') {
        readiness.set('claude', 'ready');
        readiness.set('mcp', 'unhealthy');
      } else {
        readiness.set('claude', 'unhealthy');
        readiness.set('mcp', mcpIdleStatus);
      }
      logger.warn(
        { category: error instanceof ClaudeError ? error.category : 'unknown' },
        'Claude readiness check failed',
      );
    }
  };
  await refreshClaudeReadiness();

  try {
    await client.login(config.discordToken);
  } catch {
    readiness.set('discord', 'unhealthy');
    logger.fatal({ category: 'discord_api' }, 'Discord login failed');
    database.close();
    process.exitCode = 1;
    return;
  }
  readiness.set('discord', 'ready');
  const botUserId = client.user?.id;
  if (!botUserId) {
    logger.fatal({ category: 'discord_api' }, 'Discord bot identity is unavailable');
    await client.destroy();
    database.close();
    process.exitCode = 1;
    return;
  }

  const handler = new DiscordMessageHandler(
    config,
    botUserId,
    repository,
    claude,
    scheduler,
    readiness,
    logger,
  );
  const unregister = registerMessageHandler(client, (message) => handler.handle(message), logger);
  client.on(Events.ShardDisconnect, () => readiness.set('discord', 'unhealthy'));
  client.on(Events.ShardReady, () => readiness.set('discord', 'ready'));
  logger.info({ readiness: readiness.summary() }, 'Odoo Claude bot started');

  const readinessTimer = setInterval(() => void refreshClaudeReadiness(), 60_000);
  readinessTimer.unref();
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    clearInterval(readinessTimer);
    readiness.set('discord', 'stopped');
    unregister();
    const graceful = scheduler.shutdown();
    await Promise.race([graceful, delay(config.shutdownGraceMs)]);
    await client.destroy();
    database.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
