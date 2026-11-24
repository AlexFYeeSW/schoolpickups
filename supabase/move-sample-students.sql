-- Move every student out of the 5 original sample schools and assign each one,
-- at random, to one of the 10 West Covina schools (schools-west-covina.sql),
-- spread evenly: the students are shuffled, then dealt out in turn, so each
-- school gets the same number (give or take one).
--
-- Run in the Supabase SQL Editor AFTER schools-west-covina.sql.
-- Safe to run again: once no students are left at the sample schools, it
-- changes nothing.
--
-- IMPORTANT: the West Covina schools have no dismissal times yet, so after this
-- runs every moved student shows under "Needs attention" instead of being
-- scheduled, until you enter each school's dismissal times and press
-- "Refresh driving times" on the staff page.

-- Stop if the West Covina schools haven't been added yet.
do $$
begin
  if (select count(*) from schools where id like 'wcusd-%') < 10 then
    raise exception 'Run supabase/schools-west-covina.sql first (the 10 West Covina schools are missing).';
  end if;
end $$;

with shuffled as (
  select id, row_number() over (order by random()) as n
  from students
  where school_id in ('maple', 'cedar', 'lincoln', 'riverside', 'hillcrest')
),
targets as (
  select array[
    'wcusd-california', 'wcusd-cameron', 'wcusd-merced', 'wcusd-merlinda', 'wcusd-monte-vista',
    'wcusd-orangewood', 'wcusd-vine', 'wcusd-wescove', 'wcusd-edgewood-ms', 'wcusd-hollencrest'
  ] as ids
)
update students s
set school_id = t.ids[((sh.n - 1) % 10) + 1]
from shuffled sh, targets t
where s.id = sh.id;

-- Result: students per school (the sample schools should show 0).
select sc.name, count(st.id) as students
from schools sc
left join students st on st.school_id = sc.id
group by sc.name
order by students desc, sc.name;

-- Optional, once you no longer need them: remove the 5 sample schools and their
-- driving times. Only works when no students or daily changes point to them.
-- delete from travel_times where from_id in ('maple','cedar','lincoln','riverside','hillcrest')
--                            or to_id   in ('maple','cedar','lincoln','riverside','hillcrest');
-- delete from schools where id in ('maple','cedar','lincoln','riverside','hillcrest');
