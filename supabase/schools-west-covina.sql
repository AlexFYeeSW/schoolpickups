-- 10 public schools in West Covina (West Covina Unified School District)
-- near the afterschool center at 228 S. Glendora Avenue, West Covina, CA 91790.
-- Run in the Supabase SQL Editor after schema.sql. Safe to run more than once.
--
-- Names and addresses come from the California Department of Education school
-- directory and public school listings (checked November 2026).
--
-- DISMISSAL TIMES ARE LEFT BLANK ON PURPOSE. They couldn't be confirmed from
-- the schools' official bell schedules. Students at a school with no dismissal
-- time are listed under "Needs attention" instead of being scheduled. Fill them
-- in from each school's current bell schedule (Supabase -> Table Editor ->
-- schools), including any weekly early-release day.
--
-- Re-running this file updates names and addresses but never overwrites
-- dismissal times you've entered.

insert into schools (id, name, address) values
  ('wcusd-california',  'California Elementary',  '1125 Bainbridge, West Covina, CA 91790'),
  ('wcusd-cameron',     'Cameron Elementary',     '1225 E Cameron Ave, West Covina, CA 91790'),
  ('wcusd-merced',      'Merced Elementary',      '1545 E Merced Ave, West Covina, CA 91791'),
  ('wcusd-merlinda',    'Merlinda Elementary',    '1120 Valinda Ave, West Covina, CA 91790'),
  ('wcusd-monte-vista', 'Monte Vista Elementary', '1615 W Eldred Ave, West Covina, CA 91790'),
  ('wcusd-orangewood',  'Orangewood Elementary',  '1440 S Orange Ave, West Covina, CA 91790'),
  ('wcusd-vine',        'Vine Elementary',        '1901 E Vine Ave, West Covina, CA 91791'),
  ('wcusd-wescove',     'Wescove Elementary',     '1010 W Vine Ave, West Covina, CA 91790'),
  ('wcusd-edgewood-ms', 'Edgewood Middle School', '1625 W Durness St, West Covina, CA 91790'),
  ('wcusd-hollencrest', 'Hollencrest Middle School', '2101 E Merced Ave, West Covina, CA 91791')
on conflict (id) do update
  set name = excluded.name,
      address = excluded.address;

-- To enter dismissal times by SQL instead of the Table Editor, for example:
-- update schools set dismissal_mon = '14:45', dismissal_tue = '14:45', dismissal_wed = '13:30',
--                    dismissal_thu = '14:45', dismissal_fri = '14:45'
-- where id = 'wcusd-orangewood';

-- Check which schools still need dismissal times:
-- select name from schools
-- where dismissal_mon is null or dismissal_tue is null or dismissal_wed is null
--    or dismissal_thu is null or dismissal_fri is null
-- order by name;
