-- Sample data for testing (all names are made up). Run AFTER schema.sql.
-- Safe to run more than once: rows that already exist are left unchanged.
-- To remove it later: delete from students; delete from drivers; delete from travel_times; delete from schools;
-- (only do that before you add real data, and in that order).

insert into schools (id, name, dismissal_mon, dismissal_tue, dismissal_wed, dismissal_thu, dismissal_fri) values
  ('maple', 'Maple Elementary', '15:00', '15:00', '13:30', '15:00', '15:00'),
  ('cedar', 'Cedar Grove Elementary', '14:45', '14:45', '13:15', '14:45', '14:45'),
  ('lincoln', 'Lincoln Park Elementary', '15:15', '15:15', '15:15', '15:15', '14:00'),
  ('riverside', 'Riverside Middle', '15:30', '15:30', '14:30', '15:30', '15:30'),
  ('hillcrest', 'Hillcrest Elementary', '15:00', '15:00', '15:00', '15:00', '15:00')
on conflict (id) do nothing;

insert into drivers (id, name, seats, days) values
  ('d1', 'Driver A', 7, '{mon,tue,wed,thu,fri}'),
  ('d2', 'Driver B', 7, '{mon,tue,wed,thu,fri}'),
  ('d3', 'Driver C', 10, '{mon,tue,wed,thu,fri}'),
  ('d4', 'Driver D', 12, '{mon,tue,wed,thu}')
on conflict (id) do nothing;

insert into students (id, name, school_id, days, notes) values
  ('s01', 'Ava A.', 'maple', '{mon,wed,fri}', 'Booster seat'),
  ('s02', 'Liam H.', 'cedar', '{mon,tue,wed,thu,fri}', null),
  ('s03', 'Mia O.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s04', 'Noah V.', 'riverside', '{mon,tue,wed,thu,fri}', null),
  ('s05', 'Zoe C.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s06', 'Eli J.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s07', 'Luna Q.', 'cedar', '{mon,tue,wed,thu,fri}', null),
  ('s08', 'Owen X.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s09', 'Ivy E.', 'riverside', '{mon,tue,wed,thu,fri}', null),
  ('s10', 'Leo L.', 'hillcrest', '{mon,wed,fri}', null),
  ('s11', 'Nora S.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s12', 'Kai Z.', 'cedar', '{tue,thu}', null),
  ('s13', 'Ruby G.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s14', 'Finn N.', 'riverside', '{mon,tue,wed,thu,fri}', 'Booster seat'),
  ('s15', 'Maya U.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s16', 'Jude B.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s17', 'Isla I.', 'cedar', '{mon,tue,wed,thu,fri}', null),
  ('s18', 'Theo P.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s19', 'Lila W.', 'riverside', '{mon,wed,fri}', null),
  ('s20', 'Max D.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s21', 'Aria K.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s22', 'Sam R.', 'cedar', '{mon,tue,wed,thu,fri}', null),
  ('s23', 'Elle Y.', 'lincoln', '{tue,thu}', null),
  ('s24', 'Ben F.', 'riverside', '{mon,tue,wed,thu,fri}', null),
  ('s25', 'Rosa M.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s26', 'Dev T.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s27', 'Jade A.', 'cedar', '{mon,tue,wed,thu,fri}', 'Booster seat'),
  ('s28', 'Omar H.', 'lincoln', '{mon,wed,fri}', null),
  ('s29', 'Tess O.', 'riverside', '{mon,tue,wed,thu,fri}', null),
  ('s30', 'Ian V.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s31', 'Gia C.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s32', 'Ray J.', 'cedar', '{mon,tue,wed,thu,fri}', null),
  ('s33', 'Nia Q.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s34', 'Cole X.', 'riverside', '{tue,thu}', null),
  ('s35', 'Ana E.', 'hillcrest', '{mon,tue,wed,thu,fri}', null),
  ('s36', 'Jay L.', 'maple', '{mon,tue,wed,thu,fri}', null),
  ('s37', 'Lucy S.', 'cedar', '{mon,wed,fri}', null),
  ('s38', 'Ezra Z.', 'lincoln', '{mon,tue,wed,thu,fri}', null),
  ('s39', 'Mae G.', 'riverside', '{mon,tue,wed,thu,fri}', null),
  ('s40', 'Rex N.', 'hillcrest', '{mon,tue,wed,thu,fri}', 'Booster seat')
on conflict (id) do nothing;

-- Driving minutes; one direction is enough ('base' = the afterschool center).
insert into travel_times (from_id, to_id, minutes) values
  ('base', 'maple', 8),
  ('base', 'cedar', 10),
  ('base', 'lincoln', 6),
  ('base', 'riverside', 12),
  ('base', 'hillcrest', 9),
  ('maple', 'cedar', 7),
  ('maple', 'lincoln', 9),
  ('maple', 'riverside', 11),
  ('maple', 'hillcrest', 5),
  ('cedar', 'lincoln', 8),
  ('cedar', 'riverside', 6),
  ('cedar', 'hillcrest', 10),
  ('lincoln', 'riverside', 10),
  ('lincoln', 'hillcrest', 7),
  ('riverside', 'hillcrest', 13)
on conflict (from_id, to_id) do nothing;
