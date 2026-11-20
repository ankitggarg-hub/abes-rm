-- Campus Resource Planner: Postgres schema (Neon). Safe to run more than once.

CREATE TABLE IF NOT EXISTS departments (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  code  text NOT NULL UNIQUE,
  h     int  NOT NULL DEFAULT 200
);

CREATE TABLE IF NOT EXISTS classes (
  id       text PRIMARY KEY,
  dept_id  text NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  year     int  NOT NULL,
  section  text NOT NULL,
  strength int  NOT NULL DEFAULT 0,
  tracked  boolean NOT NULL DEFAULT false,
  UNIQUE (dept_id, year, section)
);
-- Academic tracker mapping: only mapped years and sections appear in the tracker.
-- Existing sections are mapped once, when the column is first added; after that the administrator decides.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'classes' AND column_name = 'tracked') THEN
    ALTER TABLE classes ADD COLUMN tracked boolean NOT NULL DEFAULT false;
    UPDATE classes SET tracked = true;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS slots (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  start_time text NOT NULL,
  end_time   text NOT NULL
);
ALTER TABLE slots ADD COLUMN IF NOT EXISTS is_break boolean NOT NULL DEFAULT false;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS lunch_slots jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS buildings (
  id   text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS floors (
  id    text PRIMARY KEY,
  name  text NOT NULL UNIQUE,
  level int  NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS venues (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  type        text NOT NULL CHECK (type IN ('Lecture theatre','Computer lab','Seminar hall','Auditorium','Conference hall','Core lab','Tutorial room')),
  building_id text NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
  floor_id    text NOT NULL REFERENCES floors(id)    ON DELETE RESTRICT,
  capacity    int  NOT NULL CHECK (capacity > 0),
  equipment   text NOT NULL DEFAULT '',
  dept_id     text REFERENCES departments(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin','hod','head','stakeholder','viewer')),
  dept_id       text REFERENCES departments(id) ON DELETE RESTRICT,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- a view-only role (venue availability only)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','hod','head','stakeholder','viewer'));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE email <> '';

-- A department head can manage more than one department (the main one stays in dept_id)
ALTER TABLE users ADD COLUMN IF NOT EXISTS more_dept_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS timetable (
  id       text PRIMARY KEY,
  res_id   text NOT NULL REFERENCES venues(id)  ON DELETE RESTRICT,
  day      int  NOT NULL CHECK (day BETWEEN 0 AND 5),
  slot_id  text NOT NULL REFERENCES slots(id)   ON DELETE RESTRICT,
  title    text NOT NULL,
  faculty  text NOT NULL DEFAULT '',
  class_id text NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  -- one class per venue, and one class per section, in any period
  CONSTRAINT timetable_venue_unique UNIQUE (res_id, day, slot_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT timetable_class_unique UNIQUE (class_id, day, slot_id) DEFERRABLE INITIALLY DEFERRED
);
-- faculty is optional: only named faculty are checked for clashes
ALTER TABLE timetable ALTER COLUMN faculty SET DEFAULT '';
DROP INDEX IF EXISTS timetable_faculty_unique;
CREATE UNIQUE INDEX timetable_faculty_unique ON timetable (day, slot_id, lower(faculty)) WHERE faculty <> '';

-- A scheduled class that does not take place on one date (industrial visit, placement drive...).
CREATE TABLE IF NOT EXISTS releases (
  id      text PRIMARY KEY,
  tt_id   text NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
  date    date NOT NULL,
  reason  text NOT NULL,
  note    text NOT NULL DEFAULT '',
  by_name text NOT NULL,
  CONSTRAINT releases_unique UNIQUE (tt_id, date)
);
CREATE INDEX IF NOT EXISTS releases_date ON releases (date);

CREATE TABLE IF NOT EXISTS events (
  id        text PRIMARY KEY,
  res_id    text NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  date      date NOT NULL,
  slot_ids  jsonb NOT NULL,
  title     text NOT NULL,
  by_name   text NOT NULL,
  attendees int  NOT NULL DEFAULT 0,
  notes     text NOT NULL DEFAULT '',
  status    text NOT NULL CHECK (status IN ('pending','confirmed','rejected'))
);
CREATE INDEX IF NOT EXISTS events_res_date ON events (res_id, date);

-- Venue lending: a department head books one of their venues for another department, head or person
ALTER TABLE events ADD COLUMN IF NOT EXISTS for_dept_id  text REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS lent_dept_id text REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS lent_by      text NOT NULL DEFAULT '';

-- Weekly tracker of academic and training hours
CREATE TABLE IF NOT EXISTS load_types (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  kind  text NOT NULL CHECK (kind IN ('Academic','Training'))
);
CREATE UNIQUE INDEX IF NOT EXISTS load_types_name_unique ON load_types (lower(name));

CREATE TABLE IF NOT EXISTS holidays (
  id        text PRIMARY KEY,
  date_from date NOT NULL,
  date_to   date NOT NULL CHECK (date_to >= date_from),
  title     text NOT NULL,
  class_id  text REFERENCES classes(id) ON DELETE CASCADE,
  by_name   text NOT NULL DEFAULT '',
  kind      text NOT NULL DEFAULT 'off' CHECK (kind IN ('off','working'))
);
-- for databases created before working-day conversions existed
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'off' CHECK (kind IN ('off','working'));
-- part-day off days: only the periods from slot_from to slot_to
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS slot_from text REFERENCES slots(id) ON DELETE RESTRICT;
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS slot_to   text REFERENCES slots(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS holidays_dates ON holidays (date_from, date_to);

CREATE TABLE IF NOT EXISTS week_plans (
  id         text PRIMARY KEY,
  class_id   text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  load_id    text NOT NULL REFERENCES load_types(id) ON DELETE RESTRICT,
  planned    numeric(6,1) NOT NULL DEFAULT 0 CHECK (planned >= 0),
  actual     numeric(6,1) CHECK (actual >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS week_plans_unique ON week_plans (class_id, week_start, load_id);

-- Server-side sign-in sessions: lets us sign out for real, time out idle users and revoke on password/role change
CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Sign-in throttling
CREATE TABLE IF NOT EXISTS login_attempts (
  email        text PRIMARY KEY,
  attempts     int NOT NULL DEFAULT 0,
  locked_until timestamptz
);

-- Venue types: add 'Conference hall' and 'Core lab' (safe to re-run)
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_type_check;
ALTER TABLE venues ADD CONSTRAINT venues_type_check CHECK (type IN ('Lecture theatre','Computer lab','Seminar hall','Auditorium','Conference hall','Core lab','Tutorial room'));

-- Venue requests: a department head asks another department to lend a venue; the owner approves or rejects with remarks
CREATE TABLE IF NOT EXISTS venue_requests (
  id              text PRIMARY KEY,
  res_id          text NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date            date NOT NULL,
  slot_ids        jsonb NOT NULL,
  title           text NOT NULL,
  attendees       int  NOT NULL DEFAULT 0,
  reason          text NOT NULL DEFAULT '',
  from_dept_id    text REFERENCES departments(id) ON DELETE SET NULL,
  owner_dept_id   text REFERENCES departments(id) ON DELETE SET NULL,
  requested_by    text NOT NULL,
  requested_by_id text NOT NULL DEFAULT '',
  status          text NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
  remarks         text NOT NULL DEFAULT '',
  decided_by      text NOT NULL DEFAULT '',
  decided_at      text NOT NULL DEFAULT '',
  created_at      text NOT NULL DEFAULT '',
  event_id        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS venue_requests_owner ON venue_requests (owner_dept_id, status);
CREATE INDEX IF NOT EXISTS venue_requests_res_date ON venue_requests (res_id, date);

-- Venue requests, part 2: year/section, release after approval, and alert flags (safe to re-run)
ALTER TABLE venue_requests ADD COLUMN IF NOT EXISTS class_id        text REFERENCES classes(id) ON DELETE SET NULL;
ALTER TABLE venue_requests ADD COLUMN IF NOT EXISTS release_note    text NOT NULL DEFAULT '';
ALTER TABLE venue_requests ADD COLUMN IF NOT EXISTS released_at     text NOT NULL DEFAULT '';
ALTER TABLE venue_requests ADD COLUMN IF NOT EXISTS owner_seen      boolean NOT NULL DEFAULT false;
ALTER TABLE venue_requests ADD COLUMN IF NOT EXISTS requester_seen  boolean NOT NULL DEFAULT true;
ALTER TABLE venue_requests DROP CONSTRAINT IF EXISTS venue_requests_status_check;
ALTER TABLE venue_requests ADD CONSTRAINT venue_requests_status_check CHECK (status IN ('pending','approved','rejected','cancelled','released'));

-- Academic tracker: a week locks after the Monday that follows it. Only an administrator can unlock it (safe to re-run)
CREATE TABLE IF NOT EXISTS tracker_unlocks (
  id         text PRIMARY KEY,
  class_id   text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  until      date NOT NULL,
  note       text NOT NULL DEFAULT '',
  by_name    text NOT NULL DEFAULT '',
  CONSTRAINT tracker_unlocks_unique UNIQUE (class_id, week_start)
);

-- Activity log: who did what and when (administrators can read it; nothing in the app edits or deletes entries)
CREATE TABLE IF NOT EXISTS activity_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text NOT NULL DEFAULT '',
  user_name text NOT NULL DEFAULT '',
  role      text NOT NULL DEFAULT '',
  action    text NOT NULL,
  entity    text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  summary   text NOT NULL DEFAULT '',
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_log_at ON activity_log (at DESC);
CREATE INDEX IF NOT EXISTS activity_log_user ON activity_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_log_entity ON activity_log (entity, at DESC);


-- Programmes, terms and subjects; fortnightly syllabus tracker (safe to re-run)
CREATE TABLE IF NOT EXISTS programmes (
  id        text PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  semesters int  NOT NULL CHECK (semesters BETWEEN 1 AND 12)
);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS programme_id text REFERENCES programmes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS terms (
  id         text PRIMARY KEY,
  session    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('odd','even')),
  start_date date NOT NULL,
  end_date   date NOT NULL CHECK (end_date >= start_date),
  CONSTRAINT terms_unique UNIQUE (session, kind)
);

CREATE TABLE IF NOT EXISTS subjects (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  name         text NOT NULL,
  programme_id text NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  dept_id      text REFERENCES departments(id) ON DELETE CASCADE,
  semester     int  NOT NULL CHECK (semester BETWEEN 1 AND 12),
  type         text NOT NULL DEFAULT 'Theory' CHECK (type IN ('Theory','Lab','Training')),
  units        int  NOT NULL DEFAULT 5 CHECK (units BETWEEN 1 AND 30)
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_code_unique ON subjects (programme_id, COALESCE(dept_id, ''), code);

CREATE TABLE IF NOT EXISTS syllabus_progress (
  id              text PRIMARY KEY,
  class_id        text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id      text NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  fortnight_start date NOT NULL,
  units_done      int  NOT NULL DEFAULT 0 CHECK (units_done BETWEEN 0 AND 30),
  pct             int  NOT NULL DEFAULT 0 CHECK (pct BETWEEN 0 AND 100),
  remark          text NOT NULL DEFAULT '',
  CONSTRAINT syllabus_unique UNIQUE (class_id, subject_id, fortnight_start)
);

CREATE TABLE IF NOT EXISTS syllabus_unlocks (
  id              text PRIMARY KEY,
  class_id        text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  fortnight_start date NOT NULL,
  until           date NOT NULL,
  note            text NOT NULL DEFAULT '',
  by_name         text NOT NULL DEFAULT '',
  CONSTRAINT syllabus_unlocks_unique UNIQUE (class_id, fortnight_start)
);


-- Lab groups: a section split into G1, G2...; a timetable class may belong to one group (safe to re-run)
CREATE TABLE IF NOT EXISTS class_groups (
  id       text PRIMARY KEY,
  class_id text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name     text NOT NULL,
  strength int  NOT NULL DEFAULT 0 CHECK (strength >= 0),
  CONSTRAINT class_groups_unique UNIQUE (class_id, name)
);
ALTER TABLE timetable ADD COLUMN IF NOT EXISTS group_id text NOT NULL DEFAULT '';
ALTER TABLE timetable DROP CONSTRAINT IF EXISTS timetable_class_unique;
ALTER TABLE timetable ADD CONSTRAINT timetable_class_unique UNIQUE (class_id, group_id, day, slot_id) DEFERRABLE INITIALLY DEFERRED;
