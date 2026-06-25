export type FlagValue = string | boolean | string[];
export type ParsedArgs = { flags: Record<string, FlagValue>; positionals: string[] };

const REPEATABLE_FLAGS = new Set(['env-override', 'env_override', 'filter', 'hint', 'only']);

function setFlag(flags: Record<string, FlagValue>, key: string, value: string | boolean): void {
  if (!REPEATABLE_FLAGS.has(key)) {
    flags[key] = value;
    return;
  }

  const rawFlags = flags as Record<string, unknown>;
  const existing = rawFlags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }
  rawFlags[key] = [String(existing), String(value)];
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const trimmed = arg.slice(2);
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex >= 0) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        setFlag(flags, key, value);
        continue;
      }
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        setFlag(flags, trimmed, next);
        i += 1;
        continue;
      }
      setFlag(flags, trimmed, true);
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

export function toBoolean(value: FlagValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return toBoolean(value.at(-1));
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

export function getStringFlag(flags: Record<string, FlagValue>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
}

export function getStringFlags(flags: Record<string, FlagValue>, keys: string[]): string[] {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function getBooleanFlag(flags: Record<string, FlagValue>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (flags[key] !== undefined) {
      return toBoolean(flags[key]);
    }
  }
  return undefined;
}
