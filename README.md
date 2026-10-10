# Weekly Academic & Training Tracker — Neon + Vercel/Netlify deployment

This is your tracker app, unchanged in features, now backed by a real
Postgres database (Neon) instead of the chat's built-in storage.

## How it works
- `public/index.html` — the whole app (unchanged UI/logic), now talking to
  `/api/state` with `fetch` instead of the chat's storage.
- `api/state.js` — a tiny serverless function (Vercel). `GET` returns the
  saved data, `POST` overwrites it. Everything is stored as one JSON blob
  in a single Postgres row — simple, and matches how the app already works.
- `netlify/functions/state.js` + `netlify.toml` — the same function,
  written for Netlify instead, in case you deploy there.

You only need ONE of Vercel or Netlify. Pick one below.

---

## Step 1 — Create the Neon database (free)
1. Go to https://neon.tech and sign up (free tier is enough for this).
2. Click **Create a project**. Any name/region is fine.
3. On the project dashboard, copy the **connection string** — it looks like
   `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`.
   Keep this safe; you'll paste it into Vercel/Netlify as `DATABASE_URL`.
4. You don't need to create any tables by hand — `api/state.js` creates the
   table automatically the first time it runs.

## Step 2 — Put this project on GitHub
1. Create a new empty repository on GitHub.
2. Upload all the files in this project to it (or `git init`, `git add .`,
   `git commit -m "init"`, `git remote add origin <your-repo-url>`,
   `git push -u origin main`).

## Step 3a — Deploy on Vercel (recommended)
1. Go to https://vercel.com, sign up/log in, click **Add New… > Project**.
2. Import the GitHub repo you just created.
3. Before deploying, open **Environment Variables** and add:
   - Key: `DATABASE_URL`
   - Value: the Neon connection string from Step 1.
   (Optional shortcut: in the Vercel dashboard you can instead use
   **Integrations > Neon** to connect your Neon account directly — it sets
   `DATABASE_URL` for you automatically.)
4. Click **Deploy**. Vercel will detect `/api/state.js` as a serverless
   function automatically — no extra config needed.
5. Once deployed, open the URL Vercel gives you. That's your live app.

## Step 3b — Deploy on Netlify (alternative)
1. Go to https://netlify.com, sign up/log in, click **Add new site >
   Import an existing project**, and pick your GitHub repo.
2. Netlify will read `netlify.toml` automatically (publish folder `public`,
   functions folder `netlify/functions`).
3. Go to **Site settings > Environment variables** and add:
   - Key: `DATABASE_URL`
   - Value: the Neon connection string from Step 1.
4. Deploy. Open the site URL — that's your live app.

## Step 4 — First login
Open your deployed URL and sign in with:
- Username: `admin`
- Password: `admin123`

**Change this password immediately** from the Users tab — with a real
database behind it, this app is now reachable by anyone with the link.

## Notes and limits of this simple setup
- **Everyone shares one row of data.** This matches how the app worked
  before, and is fine for a single institution/department using one
  tracker. It is not multi-tenant (it can't separately serve two unrelated
  colleges from the same deployment).
- **Passwords are stored in plain text** inside that JSON blob, checked in
  the browser. Fine for an internal pilot; not acceptable for anything
  handling sensitive data. For real security, passwords should be hashed
  and checked in the API instead of the browser — I can build that if you
  want to harden it.
- **Updates refresh every ~8 seconds** (the app polls `/api/state`), not
  instantly. That's usually fine for a weekly-load tracker.
- **Concurrent edits:** the last save wins. Two people editing the exact
  same second could overwrite each other. Unlikely for this kind of usage,
  but worth knowing.
- Free tiers: Neon's free tier and Vercel/Netlify's free (hobby) tiers are
  both enough for this app's usage pattern.

## If you want more later
I can add: hashed passwords with a server-side login check, per-user data
isolation using separate database rows/tables instead of one shared blob,
email/SMS reminders, and CSV/Excel export — just ask and I'll extend the
API functions the same way `api/state.js` is written.
