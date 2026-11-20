// What happens to the day's pickups when a driver can't work: rebuild the
// schedule without them and report who moved where, and whether every
// student is still covered. Used by the website (/api/driver-unavailable) and
// the Claude Code skill in .claude/skills/driver_unavailable/.

import { buildDailySchedule, buildRoster } from "./scheduler.js";

/** Map studentId -> { driverId, driverName, time, place } for one schedule. */
function assignments(schedule) {
  const out = new Map();
  for (const r of schedule.routes) {
    for (const stop of r.stops) {
      if (stop.type !== "pickup") continue;
      for (const s of stop.students) {
        out.set(s.id, { driverId: r.driverId, driverName: r.driverName, time: stop.time, place: stop.place, name: s.name });
      }
    }
  }
  return out;
}

/**
 * Rebuild `date` without `driverId`. `data` must NOT already include the
 * driver_off change for that driver/date (it is added here).
 */
export function rescheduleWithoutDriver(data, driverId, date) {
  const driver = data.drivers.find((d) => d.id === driverId);
  if (!driver) throw new Error(`Unknown driver "${driverId}".`);

  const otherChanges = data.exceptions.filter(
    (e) => !(e.type === "driver_off" && e.driverId === driverId && e.date === date),
  );
  const base = { ...data, exceptions: otherChanges };
  const withOff = { ...data, exceptions: [...otherChanges, { type: "driver_off", date, driverId }] };

  const before = buildDailySchedule(base, date);
  const after = buildDailySchedule(withOff, date);
  const roster = buildRoster(base, date);
  const scheduledToWork = roster.drivers.some((d) => d.id === driverId);

  const was = assignments(before);
  const now = assignments(after);
  const moved = [];
  for (const [id, a] of was) {
    if (a.driverId !== driverId) continue;
    const b = now.get(id);
    moved.push({
      studentId: id,
      student: a.name,
      school: a.place,
      to: b ? b.driverName : null,
      toDriverId: b ? b.driverId : null,
      pickupTime: b ? b.time : null,
    });
  }

  const allCovered = after.unassigned.length === 0;
  const summary = !scheduledToWork
    ? `${driver.name} wasn't scheduled to drive on ${date}; nothing changes.`
    : allCovered
      ? `${driver.name} is off on ${date}. All ${after.counts.students} students are still covered by ${after.counts.drivers} driver(s); ${moved.length} moved to other drivers.`
      : `${driver.name} is off on ${date}. ${after.unassigned.length} student(s) can't be covered by the remaining drivers — find a backup driver.`;

  return {
    date,
    driver: { id: driver.id, name: driver.name },
    scheduledToWork,
    allCovered,
    summary,
    moved,
    unassigned: after.unassigned,
    warnings: after.warnings,
    before,
    after,
  };
}
