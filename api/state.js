// Vercel Serverless Function: GET returns the saved app state, POST saves it.
// Uses Neon's serverless Postgres driver. DATABASE_URL is provided automatically
// if you use the Vercel <-> Neon integration, or set it yourself in Project Settings.
const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    res.status(500).json({ error: 'DATABASE_URL is not set. Add it in Vercel Project Settings > Environment Variables.' });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  try {
    // Make sure the table exists (safe to run on every call).
    await sql`CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;

    if (req.method === 'GET') {
      const rows = await sql`SELECT data FROM app_state WHERE id = 'tracker'`;
      res.status(200).json(rows.length ? rows[0].data : null);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
      await sql`
        INSERT INTO app_state (id, data, updated_at) VALUES ('tracker', ${body}, now())
        ON CONFLICT (id) DO UPDATE SET data = ${body}, updated_at = now()
      `;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
