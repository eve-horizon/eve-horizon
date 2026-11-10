import postgres from 'postgres';

export function createDb(connectionString: string) {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export type Db = ReturnType<typeof createDb>;

export type ConnectionTarget = {
  /** Servers in the order the client tries them. */
  endpoints: Array<{ host: string; port: number }>;
  /** Database named in the startup message. */
  database: string;
  /** Role named in the startup message. */
  user: string;
  /**
   * Every other server parameter the client sends at startup (from the URL's
   * query string, e.g. application_name, options or role), by name.
   */
  startupParameters: Record<string, string>;
  /**
   * Everything the client would send or connect with, as parsed. Pass the
   * whole target to createDbFromTarget so what was checked is what is used.
   */
  clientOptions: {
    host: string[];
    port: number[];
    path: string | null;
    database: string;
    user: string;
    password: string;
    ssl: unknown;
    targetSessionAttrs: string | null;
    connection: Record<string, string>;
  };
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The parts of a target that hold a control character (NUL, newline, ...),
 * by name. Values are not returned. Such a character in a startup value
 * would let one field carry extra startup pairs.
 */
export function connectionTargetControlCharacters(target: ConnectionTarget): string[] {
  const options = target.clientOptions;
  const found: string[] = [];
  const check = (label: string, value: unknown) => {
    if (typeof value === 'string' && CONTROL_CHARACTERS.test(value)) found.push(label);
  };
  options.host.forEach((host) => check('host', host));
  check('path', options.path);
  check('database', options.database);
  check('user', options.user);
  check('password', options.password);
  check('ssl', options.ssl);
  check('target_session_attrs', options.targetSessionAttrs);
  for (const [name, value] of Object.entries(options.connection)) {
    check('parameter name', name);
    check(`parameter ${CONTROL_CHARACTERS.test(name) ? '(name)' : name}`, value);
  }
  return [...new Set(found)];
}

/**
 * Where a connection string points, read by the same parser `createDb`
 * connects with (so defaults, multi-host lists and startup parameters such
 * as `?database=` count). Opens no connection.
 */
export function describeConnectionTarget(connectionString: string): ConnectionTarget {
  const { options } = postgres(connectionString);
  const startupDatabase = options.connection?.database;
  const startupUser = options.connection?.user;
  const database = typeof startupDatabase === 'string' && startupDatabase.length > 0
    ? startupDatabase
    : options.database;
  const user = typeof startupUser === 'string' && startupUser.length > 0 ? startupUser : options.user;
  const connection = Object.fromEntries(
    Object.entries(options.connection ?? {})
      .filter(([name]) => name !== 'database' && name !== 'user')
      .map(([name, value]) => [name, String(value)]),
  );
  const raw = options as unknown as {
    path?: string | false;
    pass?: unknown;
    ssl?: unknown;
    target_session_attrs?: unknown;
  };
  return {
    endpoints: options.host.map((host, index) => ({
      host,
      port: options.port[index] ?? options.port[0],
    })),
    database,
    user,
    startupParameters: connection,
    clientOptions: {
      host: [...options.host],
      port: [...options.port],
      path: typeof raw.path === 'string' ? raw.path : null,
      database,
      user,
      password: typeof raw.pass === 'string' ? raw.pass : '',
      ssl: raw.ssl ?? false,
      targetSessionAttrs: typeof raw.target_session_attrs === 'string' ? raw.target_session_attrs : null,
      connection,
    },
  };
}

/**
 * A client built only from a target's parsed options (never from the raw
 * URL), so the user, database and startup parameters it sends are exactly
 * those that were described and checked. Callers should refuse targets with
 * control characters first (connectionTargetControlCharacters).
 */
export function createDbFromTarget(target: ConnectionTarget) {
  const options = target.clientOptions;
  return postgres({
    host: options.host,
    port: options.port,
    ...(options.path ? { path: options.path } : {}),
    database: options.database,
    username: options.user,
    password: options.password,
    ssl: options.ssl,
    ...(options.targetSessionAttrs ? { target_session_attrs: options.targetSessionAttrs } : {}),
    connection: { ...options.connection },
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  } as unknown as postgres.Options<Record<string, never>>) as unknown as Db;
}
