// Steps 2–4: work out today's roster, then assign students to drivers and order
// the stops. Plain deterministic code — the LLM never decides who goes where.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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
  const off = data.drivers.filter((d) => d.days.includes(day) && driversOff.has(d.id));

  return { date: dateStr, day, schools, students, drivers, off };
}

/** Children should be picked up within this many minutes of dismissal. */
export const TARGET_WAIT_MINUTES = 30;
const GIVE_UP_MINUTES = 60; // nobody can reach them within an hour: report as not covered
const LOAD_MINUTES = 2; // time to get children into the car at each school
// Plans tried: at least MIN_RUNS, then keep going while better plans are still
// being found (stop after STALE_RUNS tries without improvement), up to the
// maximum (PLANNER_MAX_TRIES setting, default 150). Each plan takes ~0.013 ms
// for 40 students and 10 schools once warmed up, so a schedule usually takes
// 1–2 ms, inside Cloudflare's free-plan CPU limit (10 ms). On the paid plan,
// raising PLANNER_MAX_TRIES (e.g. 400) helps on hard days.
const MIN_RUNS = 30;
const STALE_RUNS = 30;
export const DEFAULT_MAX_TRIES = 150;

// Recent results, reused when the same inputs come up again on this server
// (for example the "before" schedule in a day-off preview).
const planCache = new Map();
const PLAN_CACHE_SIZE = 50;

/** Small seeded random generator, so the "random" search gives the same answer every time. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Driving minutes between the center (index 0) and each school (index 1..n-1)
 * as a flat table, built once per schedule so each lookup is instant.
 * Missing pairs are -1 and only cause an error if a plan actually needs them.
 */
function distanceTable(travelMatrix, ids) {
  const n = ids.length;
  const dist = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { dist[i * n + j] = 0; continue; }
      const t = travelMatrix[ids[i]]?.[ids[j]] ?? travelMatrix[ids[j]]?.[ids[i]];
      if (t != null) dist[i * n + j] = t;
    }
  }
  return (a, b) => {
    const t = dist[a * n + b];
    if (t < 0) throw new Error(`No driving time saved between "${ids[a]}" and "${ids[b]}". Add it to the travel_times table.`);
    return t;
  };
}

/**
 * Build one plan. At each step, every (driver, school with children still
 * waiting) pair is considered, both going there directly and, for a part-full
 * car, dropping off at the center first. The pair with the best score is taken.
 * Run 0 uses plain "soonest arrival"; later runs add urgency and randomness to
 * explore other plans. Places are numbers: 0 = center, g + 1 = groups[g].
 */
function buildPlan(ctx, run) {
  const { groups, drivers, d } = ctx;
  const rand = seededRandom(0x5eed + run * 7919);
  const urgency = run === 0 ? 0 : rand() * 0.8; // prefer schools whose children have waited longer
  const noise = run === 0 ? 0 : rand() * 6; // minutes of random jitter in the score
  const splitPenalty = run === 0 ? 0 : rand() * 8; // dislike leaving some children behind

  const state = drivers.map((dr) => ({ driver: dr, seats: dr.seats, loc: 0, time: null, load: 0, stops: [], drive: 0 }));
  const left = groups.map((g) => g.students.length); // children still waiting per school
  const next = groups.map(() => 0); // index of the next child to pick up per school
  const waitOf = new Map(); // studentId -> minutes waited
  const unassigned = [];
  const giveUps = [];

  for (;;) {
    let bScore = Infinity, bG = -1, bS = null, bArrive = 0, bWait = 0, bAtBase = -1, bTake = 0, bDrive = 0;
    for (let g = 0; g < groups.length; g++) {
      if (!left[g]) continue;
      const dis = groups[g].school.dismissalToday;
      const place = g + 1;
      for (const st of state) {
        // mode 0: drive straight there (if seats are free); mode 1: drop off at the center first.
        for (let mode = st.load >= st.seats ? 1 : 0; mode <= (st.load > 0 ? 1 : 0); mode++) {
          let t = st.time ?? dis - d(0, place);
          let from = st.loc;
          let drive = 0;
          let atBase = -1;
          if (mode === 1) {
            const leg = d(from, 0);
            t += leg;
            drive += leg;
            from = 0;
            atBase = t;
          }
          const leg = d(from, place);
          drive += leg;
          const arrive = Math.max(t + leg, dis);
          const wait = arrive - dis;
          const take = Math.min(st.seats - (mode === 1 ? 0 : st.load), left[g]);
          const score =
            arrive - urgency * wait + (noise ? rand() * noise : 0) +
            (take < left[g] ? splitPenalty : 0) + drive * 0.01;
          if (score < bScore) {
            bScore = score; bG = g; bS = st; bArrive = arrive; bWait = wait; bAtBase = atBase; bTake = take; bDrive = drive;
          }
        }
      }
    }
    if (bG < 0) break;

    const group = groups[bG];
    if (bWait > GIVE_UP_MINUTES) {
      giveUps.push(group.school.name);
      unassigned.push(...group.students.slice(next[bG]));
      next[bG] = group.students.length;
      left[bG] = 0;
      continue;
    }
    const st = bS;
    if (bAtBase >= 0) {
      st.stops.push({ type: "dropoff", locationId: ctx.ids[0], time: bAtBase, studentIds: dropAll(st) });
      st.load = 0;
    }
    const taking = group.students.slice(next[bG], next[bG] + bTake);
    next[bG] += bTake;
    left[bG] -= bTake;
    for (const s of taking) waitOf.set(s.id, bWait);
    st.stops.push({
      type: "pickup",
      locationId: group.school.id,
      time: bArrive,
      dismissal: group.school.dismissalToday,
      studentIds: taking.map((s) => s.id),
    });
    st.load += taking.length;
    st.drive += bDrive;
    st.loc = bG + 1;
    st.time = bArrive + LOAD_MINUTES;
  }

  // Everyone returns to the center at the end.
  for (const st of state) {
    if (st.load > 0) {
      const leg = d(st.loc, 0);
      st.stops.push({ type: "dropoff", locationId: ctx.ids[0], time: st.time + leg, studentIds: dropAll(st) });
      st.drive += leg;
      st.load = 0;
    }
  }

  let over = 0, longest = 0, total = 0;
  for (const w of waitOf.values()) {
    if (w > TARGET_WAIT_MINUTES) over++;
    if (w > longest) longest = w;
    total += w;
  }
  const cost = [unassigned.length, over, longest, total, state.reduce((a, st) => a + st.drive, 0)];
  return { state, pickedAt: waitOf, unassigned, giveUps, cost };
}

const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * Step 4: assign students to drivers and order the stops so that children wait
 * as little as possible after dismissal (target: under 30 minutes), then with
 * the least driving. Tries many plans and keeps the best one.
 */
export function assignRoutes(roster, travelMatrix, baseId = "base", { maxTries = DEFAULT_MAX_TRIES } = {}) {
  const maxRuns = Number.isInteger(maxTries) && maxTries > 0 ? Math.min(maxTries, 5000) : DEFAULT_MAX_TRIES;
  const { schools, students, drivers } = roster;
  const warnings = [];

  // Sort inputs by name so the result doesn't depend on the order data arrives in.
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  const bySchool = new Map();
  for (const s of [...students].sort(byName)) {
    if (!bySchool.has(s.schoolId)) bySchool.set(s.schoolId, []);
    bySchool.get(s.schoolId).push(s);
  }

  // Students whose school is unknown or has no dismissal time today can't be scheduled.
  const unassigned = [];
  const schoolById = new Map(schools.map((s) => [s.id, s]));
  for (const [schoolId, list] of bySchool) {
    const school = schoolById.get(schoolId);
    if (!school) {
      warnings.push(`${list.length} student(s) are linked to an unknown school "${schoolId}".`);
      unassigned.push(...list);
    } else if (school.dismissalToday == null) {
      warnings.push(`${school.name} has no dismissal time for today; its students aren't scheduled.`);
      unassigned.push(...list);
    }
  }

  const groups = [...schools]
    .filter((s) => bySchool.has(s.id) && s.dismissalToday != null)
    .sort((a, b) => a.dismissalToday - b.dismissalToday || byName(a, b))
    .map((school) => ({ school, students: bySchool.get(school.id) }));

  if (!drivers.length) {
    if (students.length) warnings.push("No drivers are available today.");
    return { routes: [], unassigned: [...students], warnings, waits: emptyWaits() };
  }

  const ids = [baseId, ...groups.map((g) => g.school.id)];
  const ctx = { ids, d: distanceTable(travelMatrix, ids), groups, drivers: [...drivers].sort(byName) };
  const key = JSON.stringify([
    baseId,
    maxRuns,
    ctx.drivers.map((d) => [d.id, d.seats]),
    groups.map((g) => [g.school.id, g.school.dismissalToday, g.students.map((s) => s.id)]),
    travelMatrix,
  ]);
  let best = planCache.get(key);
  if (!best) {
    let lastImproved = 0;
    for (let run = 0; run < maxRuns; run++) {
      if (run >= MIN_RUNS && run - lastImproved >= STALE_RUNS) break;
      const plan = buildPlan(ctx, run);
      if (!best || better(plan.cost, best.cost)) {
        best = plan;
        lastImproved = run;
      }
    }
    if (planCache.size >= PLAN_CACHE_SIZE) planCache.delete(planCache.keys().next().value);
    planCache.set(key, best);
  }

  for (const name of new Set(best.giveUps)) warnings.push(`${name}: no driver can arrive within an hour of dismissal.`);
  // One warning per pickup where children wait longer than the target.
  for (const st of best.state) {
    for (const stop of st.stops) {
      if (stop.type !== "pickup") continue;
      const wait = stop.time - stop.dismissal;
      if (wait > TARGET_WAIT_MINUTES) {
        const school = schoolById.get(stop.locationId);
        warnings.push(
          `${school.name}: ${stop.studentIds.length} student(s) wait ${wait} min after dismissal ` +
            `(over the ${TARGET_WAIT_MINUTES}-minute target; ${st.driver.name}). Another driver would help.`,
        );
      }
    }
  }

  const waitList = [...best.pickedAt.values()];
  const routes = best.state
    .filter((st) => st.stops.length > 0)
    .map((st) => ({ driverId: st.driver.id, driverName: st.driver.name, seats: st.driver.seats, stops: st.stops, driveMinutes: st.drive }));

  return {
    routes,
    unassigned: [...unassigned, ...best.unassigned],
    warnings,
    waits: {
      longest: waitList.length ? Math.max(...waitList) : 0,
      average: waitList.length ? Math.round((waitList.reduce((a, b) => a + b, 0) / waitList.length) * 10) / 10 : 0,
      overTarget: waitList.filter((w) => w > TARGET_WAIT_MINUTES).length,
      target: TARGET_WAIT_MINUTES,
    },
    driveMinutes: routes.reduce((a, r) => a + r.driveMinutes, 0),
  };
}

function emptyWaits() {
  return { longest: 0, average: 0, overTarget: 0, target: TARGET_WAIT_MINUTES };
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
  const { routes, unassigned, warnings, waits, driveMinutes } = assignRoutes(roster, data.travelMinutes, data.base.id, {
    maxTries: data.plannerMaxTries,
  });

  const studentById = new Map(data.students.map((s) => [s.id, s]));
  const placeName = (id) => (id === data.base.id ? data.base.name : data.schools.find((s) => s.id === id)?.name ?? id);

  return {
    date: dateStr,
    weekday: roster.day,
    counts: { students: roster.students.length, drivers: roster.drivers.length, schools: new Set(roster.students.map((s) => s.schoolId)).size },
    warnings,
    waits,
    driveMinutes,
    driversOff: roster.off.map((d) => ({ id: d.id, name: d.name })),
    unassigned: unassigned.map((s) => ({ id: s.id, name: s.name, school: placeName(s.schoolId) })),
    routes: routes.map((r) => ({
      ...r,
      stops: r.stops.map((stop) => ({
        type: stop.type,
        place: placeName(stop.locationId),
        time: formatTime(stop.time),
        dismissal: stop.dismissal != null ? formatTime(stop.dismissal) : undefined,
        waitMinutes: stop.dismissal != null ? stop.time - stop.dismissal : undefined,
        students: stop.studentIds.map((id) => {
          const s = studentById.get(id);
          return { id, name: s.name, notes: s.notes || undefined };
        }),
      })),
    })),
  };
}
