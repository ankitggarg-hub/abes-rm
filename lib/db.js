import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Node 20 has no global WebSocket, which the Neon driver needs for transactions.
neonConfig.webSocketConstructor = ws;

/**
 * Runs `fn(db)` with a short-lived connection to Neon.
 * db.query(text, params) -> rows
 * db.tx(async (q) => ...) runs q(text, params) -> rows inside one transaction.
 */
export async function withNeon(fn, env = process.env) {
  if (!env.DATABASE_URL) {
    const e = new Error('DATABASE_URL is not set.');
    e.status = 500;
    throw e;
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    return await fn(makeDb(pool));
  } finally {
    await pool.end().catch(() => {});
  }
}

export function makeDb(pool) {
  return {
    async query(text, params) {
      return (await pool.query(text, params)).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (text, params) => (await client.query(text, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
