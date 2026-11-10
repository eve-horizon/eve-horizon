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
};

/**
 * Where a connection string points, read by the same parser `createDb`
 * connects with (so defaults, multi-host lists and startup parameters such
 * as `?database=` count). Opens no connection.
 */
export function describeConnectionTarget(connectionString: string): ConnectionTarget {
  const { options } = postgres(connectionString);
  const startupDatabase = options.connection?.database;
  const startupUser = options.connection?.user;
  return {
    endpoints: options.host.map((host, index) => ({
      host,
      port: options.port[index] ?? options.port[0],
    })),
    database: typeof startupDatabase === 'string' && startupDatabase.length > 0
      ? startupDatabase
      : options.database,
    user: typeof startupUser === 'string' && startupUser.length > 0 ? startupUser : options.user,
  };
}
