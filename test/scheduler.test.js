import { test } from "node:test";
import assert from "node:assert/strict";
import * as sample from "../src/sample-data.js";
import { buildDailySchedule, buildRoster, weekdayOf } from "../src/scheduler.js";
import { localNow } from "../src/index.js";

const MONDAY = "2026-11-16";
const FRIDAY = "2026-11-20";

function pickedUpIds(schedule) {
  return schedule.routes.flatMap((r) => r.stops.filter((s) => s.type === "pickup").flatMap((s) => s.students.map((k) => k.id)));
}

test("weekday parsing", () => {
  assert.equal(weekdayOf(MONDAY), "mon");
  assert.equal(weekdayOf(FRIDAY), "fri");
});

test("every scheduled student is picked up exactly once", () => {
  for (const date of [MONDAY, "2026-11-18", FRIDAY]) {
    const roster = buildRoster(sample, date);
    const schedule = buildDailySchedule(sample, date);
    const ids = pickedUpIds(schedule);
    assert.equal(new Set(ids).size, ids.length, "no duplicates");
    assert.equal(ids.length + schedule.unassigned.length, roster.students.length);
  }
});

test("no car is ever over capacity", () => {
  const schedule = buildDailySchedule(sample, MONDAY);
  for (const r of schedule.routes) {
    let load = 0;
    for (const s of r.stops) {
      load = s.type === "pickup" ? load + s.students.length : 0;
      assert.ok(load <= r.seats, `${r.driverName} has ${load} kids in ${r.seats} seats`);
    }
  }
});

test("daily changes: absences and drivers off", () => {
  const data = {
    ...sample,
    exceptions: [
      { date: MONDAY, type: "student_absent", studentId: "s01" },
      { date: MONDAY, type: "driver_off", driverId: "d3" },
    ],
  };
  const schedule = buildDailySchedule(data, MONDAY);
  assert.ok(!pickedUpIds(schedule).includes("s01"));
  assert.ok(!schedule.routes.some((r) => r.driverId === "d3"));
});

test("Driver D does not work Fridays", () => {
  const schedule = buildDailySchedule(sample, FRIDAY);
  assert.ok(!schedule.routes.some((r) => r.driverId === "d4"));
});

test("noon in Los Angeles across daylight saving", () => {
  assert.equal(localNow("America/Los_Angeles", new Date("2026-07-15T19:00:00Z")).hour, 12); // PDT
  assert.equal(localNow("America/Los_Angeles", new Date("2026-12-15T20:00:00Z")).hour, 12); // PST
  assert.equal(localNow("America/Los_Angeles", new Date("2026-12-15T19:00:00Z")).hour, 11);
});
