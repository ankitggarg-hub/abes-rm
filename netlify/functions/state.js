// Netlify Functions variant of api/state.js — use this folder INSTEAD of /api
// if you deploy on Netlify rather than Vercel. Same Neon table, same behaviour.
const { neon } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  if (!process.env.DATABASE_URL) {
    return { statusCode: 500, body: JSON.stringify({ error: 'DATABASE_URL is not set in Netlify Site settings > Environment variables.' }) };
  }
  const sql = neon(process.env.DATABASE_URL);

  try {
    await sql`CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT data FROM app_state WHERE id = 'tracker'`;
      return { statusCode: 200, body: JSON.stringify(rows.length ? rows[0].data : null) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await sql`
        INSERT INTO app_state (id, data, updated_at) VALUES ('tracker', ${body}, now())
        ON CONFLICT (id) DO UPDATE SET data = ${body}, updated_at = now()
      `;
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
