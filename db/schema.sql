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
  UNIQUE (dept_id, year, section)
);

CREATE TABLE IF NOT EXISTS slots (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  start_time text NOT NULL,
  end_time   text NOT NULL
);

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
  type        text NOT NULL CHECK (type IN ('Lecture theatre','Computer lab','Seminar hall','Auditorium')),
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
  role          text NOT NULL CHECK (role IN ('admin','hod','head','stakeholder')),
  dept_id       text REFERENCES departments(id) ON DELETE RESTRICT,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE email <> '';

CREATE TABLE IF NOT EXISTS timetable (
  id       text PRIMARY KEY,
  res_id   text NOT NULL REFERENCES venues(id)  ON DELETE RESTRICT,
  day      int  NOT NULL CHECK (day BETWEEN 0 AND 5),
  slot_id  text NOT NULL REFERENCES slots(id)   ON DELETE RESTRICT,
  title    text NOT NULL,
  faculty  text NOT NULL,
  class_id text NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  -- one class per venue, and one class per section, in any period
  CONSTRAINT timetable_venue_unique UNIQUE (res_id, day, slot_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT timetable_class_unique UNIQUE (class_id, day, slot_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS timetable_faculty_unique ON timetable (day, slot_id, lower(faculty));

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

-- Sign-in throttling
CREATE TABLE IF NOT EXISTS login_attempts (
  email        text PRIMARY KEY,
  attempts     int NOT NULL DEFAULT 0,
  locked_until timestamptz
);
