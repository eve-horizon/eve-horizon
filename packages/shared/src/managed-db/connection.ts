// ---------------------------------------------------------------------------
// Connection URL helpers
// ---------------------------------------------------------------------------

/** Components of a managed DB connection URL, all as strings for env injection. */
export interface ManagedDbConnectionFields {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * Split a `postgres://user:pass@host:port/db?...` URL into its components.
 * Returns null when the value is not a parseable Postgres URL (for example a
 * secret reference that has not been resolved yet), so callers can fall back
 * to publishing only the opaque URL.
 */
export function parseManagedDbConnectionUrl(value: string): ManagedDbConnectionFields | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol) || !url.hostname) {
    return null;
  }

  return {
    host: url.hostname,
    port: url.port || '5432',
    database: safeDecode(url.pathname.replace(/^\//, '')),
    username: safeDecode(url.username),
    password: safeDecode(url.password),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
