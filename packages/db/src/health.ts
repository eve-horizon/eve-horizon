import type { Db } from './client.js';

export interface DbHealthBody {
  status: 'ok' | 'degraded';
  database: 'connected' | 'disconnected';
  timestamp: string;
}

/**
 * Probe database connectivity for a service /health endpoint. Never throws;
 * callers turn `ok: false` into their framework's 503.
 */
export async function checkDbHealth(db: Db): Promise<{ ok: boolean; body: DbHealthBody }> {
  try {
    await db`SELECT 1`;
    return {
      ok: true,
      body: { status: 'ok', database: 'connected', timestamp: new Date().toISOString() },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[health] Database check failed: ${errMsg}`);
    return {
      ok: false,
      body: { status: 'degraded', database: 'disconnected', timestamp: new Date().toISOString() },
    };
  }
}
