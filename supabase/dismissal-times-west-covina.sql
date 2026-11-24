-- Dismissal times for the 10 West Covina schools (schools-west-covina.sql):
--   Monday, Tuesday, Wednesday, Friday: 2:20 PM
--   Thursday (early release):           1:15 PM
-- Run in the Supabase SQL Editor after schools-west-covina.sql. Safe to re-run.
-- To change one school later, edit it in Supabase -> Table Editor -> schools.

update schools
set dismissal_mon = '14:20:00',
    dismissal_tue = '14:20:00',
    dismissal_wed = '14:20:00',
    dismissal_thu = '13:15:00',
    dismissal_fri = '14:20:00'
where id in (
  'wcusd-california', 'wcusd-cameron', 'wcusd-merced', 'wcusd-merlinda', 'wcusd-monte-vista',
  'wcusd-orangewood', 'wcusd-vine', 'wcusd-wescove', 'wcusd-edgewood-ms', 'wcusd-hollencrest'
);

-- Result: should list all 10 schools with their times.
select name, dismissal_mon, dismissal_tue, dismissal_wed, dismissal_thu, dismissal_fri
from schools
where id like 'wcusd-%'
order by name;
