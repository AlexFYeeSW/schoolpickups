-- Supabase schema for the pickup app (not connected yet).
-- Run in the Supabase SQL editor when you're ready to move off sample data.
-- Safe to run more than once: existing tables are left as they are (no data is
-- deleted). If a table already existed with different columns, it is NOT
-- changed. Use the check query at the bottom of this file to compare.

create table if not exists schools (
  id          text primary key,
  name        text not null,
  address     text,
  -- dismissal time per weekday
  dismissal_mon time, dismissal_tue time, dismissal_wed time,
  dismissal_thu time, dismissal_fri time
);

create table if not exists drivers (
  id      text primary key,
  name    text not null,
  phone   text,
  email   text,
  seats   int  not null check (seats > 0),
  days    text[] not null default '{mon,tue,wed,thu,fri}'
);

create table if not exists students (
  id         text primary key,
  name       text not null,
  school_id  text not null references schools(id),
  days       text[] not null default '{mon,tue,wed,thu,fri}',
  notes      text,
  guardian_contact text,
  active     boolean not null default true
);

-- Travel minutes between two places ('base' = the afterschool center).
create table if not exists travel_times (
  from_id  text not null,
  to_id    text not null,
  minutes  int  not null,
  primary key (from_id, to_id)
);

-- Daily changes (absences, driver off, early release, extra pickup).
create table if not exists exceptions (
  id          bigint generated always as identity primary key,
  date        date not null,
  type        text not null check (type in ('student_absent','driver_off','dismissal_change','extra_pickup')),
  student_id  text references students(id),
  driver_id   text references drivers(id),
  school_id   text references schools(id),
  dismissal   time,
  source_text text,           -- original message, if parsed by the LLM
  confirmed   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- The locked schedule that was sent each day, plus delivery results.
create table if not exists schedules (
  date        date primary key,
  data        jsonb not null,
  locked_at   timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists deliveries (
  id          bigint generated always as identity primary key,
  date        date not null references schedules(date),
  driver_id   text not null references drivers(id),
  message     text not null,
  status      text not null,  -- sent | failed
  error       text,
  sent_at     timestamptz not null default now()
);

-- Student data is private: lock every table down. The Worker uses the
-- service-role key (stored as a Worker secret), which bypasses RLS.
alter table schools      enable row level security;
alter table drivers      enable row level security;
alter table students     enable row level security;
alter table travel_times enable row level security;
alter table exceptions   enable row level security;
alter table schedules    enable row level security;
alter table deliveries   enable row level security;

-- Check what exists (run on its own):
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('schools','drivers','students','travel_times','exceptions','schedules','deliveries')
-- order by table_name, ordinal_position;
