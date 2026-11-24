import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailySchedule, TARGET_WAIT_MINUTES } from "../src/scheduler.js";

const ALL = ["mon", "tue", "wed", "thu", "fri"];
const MON = "2026-11-30";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Schools scattered 0.5–3 miles from the center, all letting out at 2:20 PM. */
function layout(seed, { schools = 10, perSchool = 4, seats = [7, 7, 10, 12] } = {}) {
  const r = rng(seed);
  const pts = { base: [0, 0] };
  const sch = [];
  for (let i = 0; i < schools; i++) {
    const ang = r() * Math.PI * 2, dist = 0.5 + r() * 2.5;
    pts[`s${i}`] = [Math.cos(ang) * dist, Math.sin(ang) * dist];
    sch.push({ id: `s${i}`, name: `School ${String(i).padStart(2, "0")}`, dismissal: Object.fromEntries(ALL.map((d) => [d, 860])) });
  }
  const ids = Object.keys(pts);
  const travelMinutes = {};
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const miles = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
    (travelMinutes[a] ??= {})[b] = Math.max(3, Math.round(3 + miles * 2.4));
  }
  const students = [];
  sch.forEach((s, i) => { for (let k = 0; k < perSchool; k++) students.push({ id: `st${i}_${k}`, name: `Kid ${i}-${k}`, schoolId: s.id, days: ALL, notes: "" }); });
  const drivers = seats.map((n, i) => ({ id: `d${i}`, name: `Driver ${"ABCDEFG"[i]}`, seats: n, days: ALL }));
  return { base: { id: "base", name: "Center" }, schools: sch, drivers, students, travelMinutes, exceptions: [] };
}

function pickups(s) {
  return s.routes.flatMap((r) => r.stops.filter((x) => x.type === "pickup").map((x) => ({ ...x, driver: r.driverId, seats: r.seats })));
}

test("every child is picked up within 30 minutes on 40 realistic layouts (4 drivers, 10 schools)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const data = layout(seed);
    const s = buildDailySchedule(data, MON);
    assert.equal(s.unassigned.length, 0, `seed ${seed}`);
    assert.equal(pickups(s).reduce((n, p) => n + p.students.length, 0), 40, `seed ${seed}: everyone picked up once`);
    assert.ok(s.waits.longest <= TARGET_WAIT_MINUTES, `seed ${seed}: longest wait ${s.waits.longest}`);
    assert.equal(s.waits.overTarget, 0);
    for (const p of pickups(s)) assert.equal(p.waitMinutes, Math.max(0, p.waitMinutes), "no pickup before dismissal");
  }
});

test("cars never go over their seats, and every pickup is dropped at the center", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = buildDailySchedule(layout(seed, { perSchool: 5 }), MON);
    for (const r of s.routes) {
      let inCar = new Set();
      for (const stop of r.stops) {
        if (stop.type === "pickup") {
          for (const k of stop.students) inCar.add(k.id);
          assert.ok(inCar.size <= r.seats, `seed ${seed}: ${r.driverName} has ${inCar.size} in ${r.seats} seats`);
        } else {
          assert.deepEqual(new Set(stop.students.map((k) => k.id)), inCar, "drops off exactly who is in the car");
          inCar = new Set();
        }
      }
      assert.equal(inCar.size, 0, "car is empty at the end");
    }
  }
});

test("the same inputs always give the same schedule (every page must agree)", () => {
  const a = buildDailySchedule(layout(7), MON);
  const shuffled = layout(7);
  shuffled.students.reverse();
  shuffled.drivers.reverse();
  shuffled.schools.reverse();
  const b = buildDailySchedule(shuffled, MON);
  assert.deepEqual(b.routes, a.routes);
  assert.deepEqual(b.waits, a.waits);
});

test("when waits over 30 minutes can't be avoided, they're reported with a suggestion", () => {
  // 10 schools, one 7-seat driver: impossible to keep everyone under 30 minutes.
  const s = buildDailySchedule(layout(3, { seats: [7] }), MON);
  assert.ok(s.waits.overTarget > 0);
  assert.ok(s.warnings.some((w) => /over the 30-minute target.*Another driver would help/.test(w)));
  const covered = pickups(s).reduce((n, p) => n + p.students.length, 0);
  assert.equal(covered + s.unassigned.length, 40, "every child is either scheduled or listed as not covered");
});

test("reported waits match the stops", () => {
  const s = buildDailySchedule(layout(11), MON);
  const waits = pickups(s).flatMap((p) => p.students.map(() => p.waitMinutes));
  assert.equal(s.waits.longest, Math.max(...waits));
  assert.equal(s.waits.average, Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10);
  assert.ok(s.driveMinutes > 0);
});

test("cached results aren't affected by changes to a returned schedule", () => {
  const first = buildDailySchedule(layout(5), MON);
  first.routes[0].stops.length = 0;
  first.waits.longest = 999;
  const again = buildDailySchedule(layout(5), MON);
  assert.ok(again.routes[0].stops.length > 0);
  assert.notEqual(again.waits.longest, 999);
});

test("a missing driving time is reported clearly", () => {
  const data = layout(2);
  delete data.travelMinutes.s3.s4;
  delete data.travelMinutes.s4.s3;
  assert.throws(() => buildDailySchedule(data, MON), /No driving time saved between "s[34]" and "s[34]"/);
});
