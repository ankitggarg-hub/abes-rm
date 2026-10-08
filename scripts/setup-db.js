// Creates the tables in your Neon database and makes the first administrator.
//   DATABASE_URL=... ADMIN_EMAIL=you@college.edu ADMIN_PASSWORD='a long password' npm run db:setup
// Safe to run again: existing tables and users are left alone.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { hashPassword } from '../lib/auth.js';

neonConfig.webSocketConstructor = ws;

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy it from the Neon dashboard (Connect).');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
try {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log('Tables are ready.');

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  if (rows[0].n > 0) {
    console.log('An administrator already exists. Nothing more to do.');
  } else if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('No administrator yet. Run again with ADMIN_EMAIL and ADMIN_PASSWORD set.');
  } else if (ADMIN_PASSWORD.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters.');
    process.exitCode = 1;
  } else {
    const id = 'u_' + randomBytes(5).toString('hex');
    await pool.query(
      `INSERT INTO users (id, name, email, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)`,
      [id, ADMIN_NAME || 'Administrator', ADMIN_EMAIL.trim().toLowerCase(), await hashPassword(ADMIN_PASSWORD)]
    );
    console.log(`Administrator created: ${ADMIN_EMAIL.trim().toLowerCase()}`);
  }
} finally {
  await pool.end();
}
