import pino, { type DestinationStream, type Logger } from 'pino';

const REDACT_PATHS = [
  'discordToken',
  'token',
  'authorization',
  'headers.authorization',
  'prompt',
  'response',
  'stdout',
  'stderr',
  '*.token',
  '*.prompt',
  '*.response',
  '*.stdout',
  '*.stderr',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        err(error: Error) {
          return { name: error.name, message: error.message };
        },
      },
    },
    destination,
  );
}
