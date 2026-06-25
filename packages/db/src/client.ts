import postgres from 'postgres';

export function createDb(connectionString: string) {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export type Db = ReturnType<typeof createDb>;
