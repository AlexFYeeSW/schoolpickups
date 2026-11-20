// Steps 2–4: work out today's roster, then assign students to drivers and order
// the stops. Plain deterministic code — the LLM never decides who goes where.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_WAIT_MINUTES = 15; // how long a student may wait after dismissal

export function weekdayOf(dateStr) {
  // dateStr is "YYYY-MM-DD"; parse as UTC so the weekday doesn't shift.
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

export function travel(matrix, a, b) {
  if (a === b) return 0;
  const t = matrix[a]?.[b] ?? matrix[b]?.[a];
  if (t == null) throw new Error(`No driving time saved between "${a}" and "${b}". Add it to the travel_times table.`);
  return t;
}

/** Step 2: apply the day's changes to the master data. */
export function buildRoster(data, dateStr) {
  const day = weekdayOf(dateStr);
  const ex = data.exceptions.filter((e) => e.date === dateStr);
  const absent = new Set(ex.filter((e) => e.type === "student_absent").map((e) => e.studentId));
  const extra = new Set(ex.filter((e) => e.type === "extra_pickup").map((e) => e.studentId));
  const driversOff = new Set(ex.filter((e) => e.type === "driver_off").map((e) => e.driverId));
  const dismissalChanges = new Map(
    ex.filter((e) => e.type === "dismissal_change").map((e) => [e.schoolId, e.dismissal]),
  );

  const schools = data.schools.map((s) => ({
    ...s,
    dismissalToday: dismissalChanges.get(s.id) ?? s.dismissal[day],
  }));
  const students = data.students.filter(
    (s) => (s.days.includes(day) || extra.has(s.id)) && !absent.has(s.id),
  );
  const drivers = data.drivers.filter((d) => d.days.includes(day) && !driversOff.has(d.id));

  return { date: dateStr, day, schools, students, drivers };
}

/**
 * Step 4: greedy assignment. Schools are handled in dismissal order. For each
 * school, the driver who can get there earliest (returning to base first to
 * drop off kids if their car is full) takes as many students as they have seats.
 */
export function assignRoutes(roster, travelMatrix, baseId = "base") {
  const { schools, students, drivers } = roster;
  const warnings = [];

  // Sort inputs by name so the result doesn't depend on the order data arrives in.
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const state = [...drivers].sort(byName).map((d) => ({
    driver: d,
    location: baseId,
    time: null, // minutes after midnight; null = hasn't left yet
    load: 0,
    stops: [],
  }));

  const bySchool = new Map();
  for (const s of [...students].sort(byName)) {
    if (!bySchool.has(s.schoolId)) bySchool.set(s.schoolId, []);
    bySchool.get(s.schoolId).push(s);
  }

  // Students whose school is unknown or has no dismissal time today can't be scheduled.
  const unassigned = [];
  const schoolIds = new Set(schools.map((s) => s.id));
  for (const [schoolId, list] of bySchool) {
    const school = schools.find((s) => s.id === schoolId);
    if (!schoolIds.has(schoolId)) {
      warnings.push(`${list.length} student(s) are linked to an unknown school "${schoolId}".`);
      unassigned.push(...list);
    } else if (school.dismissalToday == null) {
      warnings.push(`${school.name} has no dismissal time for today; its students aren't scheduled.`);
      unassigned.push(...list);
    }
  }

  const order = schools
    .filter((s) => bySchool.has(s.id) && s.dismissalToday != null)
    .sort((a, b) => a.dismissalToday - b.dismissalToday || a.name.localeCompare(b.name));

  if (state.length === 0 && students.length > 0) {
    warnings.push("No drivers are available today.");
    return { routes: [], unassigned: students, warnings };
  }

  for (const school of order) {
    const waiting = [...bySchool.get(school.id)];
    while (waiting.length > 0) {
      // Work out when each driver could be at this school with free seats.
      const options = state.map((st) => {
        let loc = st.location;
        let t = st.time ?? school.dismissalToday - travel(travelMatrix, baseId, school.id);
        let atBase = null;
        if (st.load >= st.driver.seats) {
          t += travel(travelMatrix, loc, baseId);
          loc = baseId;
          atBase = t;
        }
        const arrive = Math.max(t + travel(travelMatrix, loc, school.id), school.dismissalToday);
        const seats = st.driver.seats - (atBase != null ? 0 : st.load);
        return { st, arrive, atBase, seats };
      });

      options.sort((a, b) => a.arrive - b.arrive || b.seats - a.seats);
      const pick = options[0];
      const late = pick.arrive - school.dismissalToday;

      if (late > MAX_WAIT_MINUTES * 4) {
        // Nobody can get there in any reasonable time.
        unassigned.push(...waiting.splice(0));
        warnings.push(`${school.name}: no driver can arrive within an hour of dismissal.`);
        break;
      }
      if (late > MAX_WAIT_MINUTES) {
        warnings.push(`${school.name}: students wait ${late} min after dismissal.`);
      }

      const st = pick.st;
      if (pick.atBase != null) {
        st.stops.push({ type: "dropoff", locationId: baseId, time: pick.atBase, studentIds: dropAll(st) });
        st.load = 0;
      }
      const taking = waiting.splice(0, pick.seats);
      st.stops.push({
        type: "pickup",
        locationId: school.id,
        time: pick.arrive,
        dismissal: school.dismissalToday,
        studentIds: taking.map((s) => s.id),
      });
      st.load += taking.length;
      st.location = school.id;
      st.time = pick.arrive + 2; // a couple of minutes to load
    }
  }

  // Everyone returns to base at the end.
  for (const st of state) {
    if (st.load > 0) {
      const t = st.time + travel(travelMatrix, st.location, baseId);
      st.stops.push({ type: "dropoff", locationId: baseId, time: t, studentIds: dropAll(st) });
      st.load = 0;
    }
  }

  const routes = state
    .filter((st) => st.stops.length > 0)
    .map((st) => ({ driverId: st.driver.id, driverName: st.driver.name, seats: st.driver.seats, stops: st.stops }));

  return { routes, unassigned, warnings };
}

// Students currently in the car = picked up since the last drop-off.
function dropAll(st) {
  const ids = [];
  for (let i = st.stops.length - 1; i >= 0 && st.stops[i].type !== "dropoff"; i--) {
    ids.unshift(...st.stops[i].studentIds);
  }
  return ids;
}

export function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Steps 2–4 together, with names filled in so the output is ready to display. */
export function buildDailySchedule(data, dateStr) {
  const roster = buildRoster(data, dateStr);
  const { routes, unassigned, warnings } = assignRoutes(roster, data.travelMinutes, data.base.id);

  const studentById = new Map(data.students.map((s) => [s.id, s]));
  const placeName = (id) => (id === data.base.id ? data.base.name : data.schools.find((s) => s.id === id)?.name ?? id);

  return {
    date: dateStr,
    weekday: roster.day,
    counts: { students: roster.students.length, drivers: roster.drivers.length, schools: new Set(roster.students.map((s) => s.schoolId)).size },
    warnings,
    unassigned: unassigned.map((s) => ({ id: s.id, name: s.name, school: placeName(s.schoolId) })),
    routes: routes.map((r) => ({
      ...r,
      stops: r.stops.map((stop) => ({
        type: stop.type,
        place: placeName(stop.locationId),
        time: formatTime(stop.time),
        dismissal: stop.dismissal != null ? formatTime(stop.dismissal) : undefined,
        students: stop.studentIds.map((id) => {
          const s = studentById.get(id);
          return { id, name: s.name, notes: s.notes || undefined };
        }),
      })),
    })),
  };
}
