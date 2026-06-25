const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|authorization|cookie|session|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|access[_-]?token)/i;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function redactUrlCredentials(value: string): string {
  if (!URL_PATTERN.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
      return url.toString();
    }
  } catch {
    return value;
  }

  return value;
}

function redactString(value: string): string {
  let output = value;

  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
  output = output.replace(
    /(token|secret|password|api[_-]?key|authorization|cookie|session|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|access[_-]?token)\s*[:=]\s*([^\s,;]+)/gi,
    (_match, key: string) => `${key}=${REDACTED}`,
  );

  return redactUrlCredentials(output);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 6) {
    return '[Truncated]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return [key, REDACTED];
    }
    return [key, redactValue(entry, seen, depth + 1)];
  });

  return Object.fromEntries(entries);
}

export function redactLogData<T>(value: T): T {
  return redactValue(value, new WeakSet<object>(), 0) as T;
}
