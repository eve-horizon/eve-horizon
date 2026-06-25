import { getCorrelationLogFields } from './observability.js';
import { redactLogData } from './redaction.js';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

export type JsonLogger = {
  log: (message: unknown, context?: string) => void;
  error: (message: unknown, trace?: string, context?: string) => void;
  warn: (message: unknown, context?: string) => void;
  debug: (message: unknown, context?: string) => void;
  verbose: (message: unknown, context?: string) => void;
};

function normalizeMessage(message: unknown): { message: string; data?: unknown } {
  if (message instanceof Error) {
    return { message: message.message, data: { name: message.name, stack: message.stack } };
  }

  if (typeof message === 'string') {
    return { message };
  }

  return { message: 'log', data: message };
}

function emitLog(
  level: LogLevel,
  service: string,
  message: unknown,
  context?: string,
  trace?: string,
): void {
  const base = normalizeMessage(message);
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service,
    ...getCorrelationLogFields(),
    context,
    message: base.message,
    ...(base.data ? { data: base.data } : {}),
    ...(trace ? { trace } : {}),
  };

  const output = JSON.stringify(redactLogData(payload));
  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export function createJsonLogger(service: string): JsonLogger {
  return {
    log: (message, context) => emitLog('log', service, message, context),
    error: (message, trace, context) => emitLog('error', service, message, context, trace),
    warn: (message, context) => emitLog('warn', service, message, context),
    debug: (message, context) => emitLog('debug', service, message, context),
    verbose: (message, context) => emitLog('verbose', service, message, context),
  };
}
