import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as sample from "../src/sample-data.js";
import { rescheduleWithoutDriver } from "../src/reschedule.js";
import { markDriverOff, clearDriverOff } from "../src/db.js";

const MONDAY = "2026-11-16";
const FRIDAY = "2026-11-20";

test("one driver off: every student is still covered by the others", () => {
  const r = rescheduleWithoutDriver(sample, "d2", MONDAY);
  assert.equal(r.scheduledToWork, true);
  assert.equal(r.allCovered, true);
  assert.equal(r.unassigned.length, 0);
  assert.ok(r.moved.length > 0);
  for (const m of r.moved) {
    assert.ok(m.to, `${m.student} has a new driver`);
    assert.notEqual(m.toDriverId, "d2");
  }
  assert.ok(!r.after.routes.some((x) => x.driverId === "d2"));
  assert.equal(r.after.counts.students, r.before.counts.students);
  assert.match(r.summary, /All 37 students are still covered by 3 driver/);
});

test("no car goes over capacity after rescheduling", () => {
  const r = rescheduleWithoutDriver(sample, "d3", MONDAY);
  for (const route of r.after.routes) {
    let load = 0;
    for (const s of route.stops) {
      load = s.type === "pickup" ? load + s.students.length : 0;
      assert.ok(load <= route.seats);
    }
  }
});

test("too few drivers: uncovered students are reported, not hidden", () => {
  const data = {
    ...sample,
    exceptions: [
      { type: "driver_off", date: MONDAY, driverId: "d1" },
      { type: "driver_off", date: MONDAY, driverId: "d3" },
      { type: "driver_off", date: MONDAY, driverId: "d4" },
    ],
  };
  const r = rescheduleWithoutDriver(data, "d2", MONDAY);
  assert.equal(r.allCovered, false);
  assert.equal(r.unassigned.length, r.before.counts.students);
  assert.match(r.summary, /can't be covered.*backup driver/);
});

test("a driver who wasn't scheduled that day changes nothing", () => {
  const r = rescheduleWithoutDriver(sample, "d4", FRIDAY); // Driver D doesn't work Fridays
  assert.equal(r.scheduledToWork, false);
  assert.equal(r.moved.length, 0);
  assert.match(r.summary, /wasn't scheduled/);
});

test("unknown driver is an error", () => {
  assert.throws(() => rescheduleWithoutDriver(sample, "nobody", MONDAY), /Unknown driver/);
});

// ---- database writes (mocked Supabase) ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const env = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };

function fakeSupabase(existingRows) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, prefer: init.headers.Prefer });
    if (init.method === "GET") return new Response(JSON.stringify(existingRows));
    if (init.method === "DELETE") return new Response(JSON.stringify(existingRows));
    return new Response("", { status: 201 });
  };
  return calls;
}

test("marking a driver off inserts one confirmed row", async () => {
  const calls = fakeSupabase([]);
  const r = await markDriverOff(env, "d2", MONDAY, "Reported by the driver");
  assert.equal(r.created, true);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { date: MONDAY, type: "driver_off", driver_id: "d2", confirmed: true, source_text: "Reported by the driver" });
  assert.ok(post.url.endsWith("/rest/v1/exceptions"));
});

test("marking the same driver off twice doesn't duplicate", async () => {
  const calls = fakeSupabase([{ id: 7 }]);
  const r = await markDriverOff(env, "d2", MONDAY);
  assert.equal(r.created, false);
  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.ok(calls.some((c) => c.method === "PATCH" && c.body.confirmed === true));
});

test("undo removes the driver_off row for that driver and day only", async () => {
  const calls = fakeSupabase([{ id: 7 }]);
  const r = await clearDriverOff(env, "d2", MONDAY);
  assert.equal(r.removed, 1);
  const del = calls.find((c) => c.method === "DELETE");
  assert.match(del.url, /driver_id=eq\.d2&date=eq\.2026-11-16&type=eq\.driver_off/);
});
