// Loads a demo campus into your database. It REPLACES all planner data.
//   DATABASE_URL=... DEMO_PASSWORD='something long' CONFIRM=yes npm run db:seed-demo
// Every demo user gets DEMO_PASSWORD. Use it for trying things out, not for real use.
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { makeDb } from '../lib/db.js';
import { loadDemo } from '../lib/seed.js';

neonConfig.webSocketConstructor = ws;
const { DATABASE_URL, DEMO_PASSWORD, CONFIRM } = process.env;
if (!DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8) { console.error('Set DEMO_PASSWORD to at least 8 characters.'); process.exit(1); }
if (CONFIRM !== 'yes') { console.error('This replaces all existing planner data. Run again with CONFIRM=yes.'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });
try {
  const counts = await makeDb(pool).tx((q) => loadDemo(q, { password: DEMO_PASSWORD }));
  console.log('Demo data loaded:', counts);
  console.log('Sign in as meera.iyer@college.example (administrator) with DEMO_PASSWORD.');
} finally {
  await pool.end();
}
