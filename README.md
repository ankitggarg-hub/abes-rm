# Campus Resource Planner

Manage lecture theatres, computer labs, seminar halls and auditoriums.

- **Admin**: masters (departments, years & sections, time slots, buildings, floors, venues, users), allocates venues to departments.
- **Department heads**: weekly/daily timetable on their allocated venues, and **Class changes** (see below).
- **Head of institute / stakeholders**: find free venues, request or book events. Heads approve requests.
- **Breaks**: mark a time slot as a break (Masters → Time slots). Nothing can be scheduled or booked in it.
- **Full-day allotment**: Timetables → "Allot a full day" fills one subject and section across several periods and days in one step, skipping periods already taken.
- **Faculty name is optional** on every class.
- **Class changes**: when a class is away on a given date (industrial visit, placement drive, seminar, exam...), release it. Its regular room shows as free on the Overview, in Availability (marked "class away") and can be booked, without touching the weekly timetable. Releasing can be done for one section or a whole department, for a date range and a range of periods. "Restore class" undoes it.

Stack: static front end (`public/`) + serverless API (`api/`, `netlify/functions/`) + Neon Postgres. Host on Vercel **or** Netlify; code on GitHub.

```
public/            index.html, app.js, styles.css
api/[...path].js   Vercel function adapter
netlify/functions/ Netlify function adapter
lib/               shared API logic (auth, validation, permissions, DB)
db/schema.sql      database tables
scripts/           db:setup, db:seed-demo, local dev server
test/              API + permission tests (npm test)
```

## Try it locally (no accounts needed)
```
npm install
npm run dev        # http://localhost:3000, in-memory demo data
```
Demo logins are printed in the terminal (admin `meera.iyer@college.example`, password `demo-password-1`).

## Deploy

### 1. Neon (database)
Create a project at neon.tech. Dashboard → **Connect** → copy the **pooled** connection string. This is `DATABASE_URL`.

### 2. GitHub
```
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/campus-resource-planner.git
git push -u origin main
```
CI (`npm test`) runs on every push.

### 3. Create tables and the first admin (once; safe to re-run, also after upgrades)
```
cp .env.example .env     # fill DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (8+ chars)
npm install
node --env-file=.env scripts/setup-db.js
```
Or GitHub → Actions → **Set up database**, after adding repository secrets `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

### 4a. Vercel
Import the GitHub repo, framework preset **Other**. Environment variables:
- `DATABASE_URL`
- `SESSION_SECRET` (32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

### 4b. Netlify
Add new site → Import from GitHub. Build settings come from `netlify.toml`. Add the same two environment variables.

### 5. First use
Open the site, sign in with the admin account, then add departments, venues, years & sections and users under **Masters**. Every user has an email and a password set there.

## Demo data (optional)
`DEMO_PASSWORD=... CONFIRM=yes node --env-file=.env scripts/seed-demo.js` **wipes** all tables and loads a sample college. Never run it on real data.

## Security notes
- Passwords are bcrypt-hashed; sessions are 12-hour HttpOnly cookies; 5 failed sign-ins lock an account for 15 minutes.
- Permissions are enforced on the server: admin everything; department head only own department's timetable and releases; head of institute events and releases; stakeholders only their own event requests.
- Logic is tested against Postgres (PGlite) with `npm test`. The live Neon, Vercel and Netlify connections were not exercised while building: after deploying, open `/api/health`.
- Excel import/export and the Google Sheets sync have been removed; the database is Neon.
