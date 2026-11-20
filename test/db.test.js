import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadData, dbStatus, fromRows, toMinutes } from "../src/db.js";
import { buildDailySchedule } from "../src/scheduler.js";
import * as sample from "../src/sample-data.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const URL_ = "https://abc.supabase.co";

test("dbStatus explains what is missing", () => {
  assert.equal(dbStatus({}), "not-configured");
  assert.equal(dbStatus({ SUPABASE_URL: URL_, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }), "needs-secret-key");
  assert.equal(dbStatus({ SUPABASE_URL: URL_, SUPABASE_SECRET_KEY: "sb_secret_x" }), "connected");
});

test("without the secret key, sample data is used", async () => {
  globalThis.fetch = () => { throw new Error("should not call Supabase"); };
  const d = await loadData({ SUPABASE_URL: URL_, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }, "2026-11-20");
  assert.equal(d.source, "sample");
  assert.equal(d.dbStatus, "needs-secret-key");
});

test("reads every table with the secret key in the apikey header", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const table = new URL(url).pathname.split("/").pop();
    return json({
      schools: [{ id: "maple", name: "Maple", dismissal_mon: "15:00:00", dismissal_tue: "15:00:00", dismissal_wed: "13:30:00", dismissal_thu: "15:00:00", dismissal_fri: "15:00:00" }],
      drivers: [{ id: "d1", name: "Ann", seats: 6, days: ["mon", "fri"] }],
      students: [{ id: "s1", name: "Leo", school_id: "maple", days: ["fri"], notes: null }],
      travel_times: [{ from_id: "base", to_id: "maple", minutes: 8 }],
      exceptions: [],
    }[table]);
  };
  const d = await loadData({ SUPABASE_URL: `${URL_}/`, SUPABASE_SECRET_KEY: " sb_secret_abc " }, "2026-11-20");
  assert.equal(d.source, "supabase");
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.ok(c.url.startsWith(`${URL_}/rest/v1/`), c.url);
    assert.equal(c.headers.apikey, "sb_secret_abc");
    assert.equal(c.headers.Authorization, undefined, "new keys are not sent as Bearer tokens");
  }
  assert.ok(calls.some((c) => c.url.includes("students?select=*&active=eq.true")));
  assert.ok(calls.some((c) => c.url.includes("exceptions?select=*&confirmed=eq.true&date=gte.2026-11-13&date=lte.2027-01-19")));
  assert.deepEqual(d.schools[0].dismissal, { mon: 900, tue: 900, wed: 810, thu: 900, fri: 900 });
  assert.deepEqual(d.travelMinutes, { base: { maple: 8 } });
  const s = buildDailySchedule(d, "2026-11-20");
  assert.equal(s.routes[0].stops[0].students[0].name, "Leo");
});

test("legacy service_role JWT keys are also sent as Bearer", async () => {
  let headers;
  globalThis.fetch = async (_url, init) => { headers = init.headers; return json([]); };
  await loadData({ SUPABASE_URL: URL_, SUPABASE_SECRET_KEY: "eyJhbGciOi.test.key" }, "2026-11-20");
  assert.equal(headers.Authorization, "Bearer eyJhbGciOi.test.key");
});

test("clear errors for a refused key and a missing table", async () => {
  const env = { SUPABASE_URL: URL_, SUPABASE_SECRET_KEY: "sb_secret_abc" };
  globalThis.fetch = async () => json({ message: "Invalid API key" }, 401);
  await assert.rejects(loadData(env, "2026-11-20"), /refused the key \(401\).*sb_secret_/);
  globalThis.fetch = async () => json({ message: "relation \"public.schools\" does not exist" }, 404);
  await assert.rejects(loadData(env, "2026-11-20"), /wasn't found\. Run supabase\/schema\.sql/);
});

test("time conversion", () => {
  assert.equal(toMinutes("15:00:00"), 900);
  assert.equal(toMinutes("9:05"), 545);
  assert.equal(toMinutes(null), undefined);
});

test("the schedule doesn't depend on the order rows arrive in", () => {
  const reversed = { ...sample, schools: [...sample.schools].reverse(), drivers: [...sample.drivers].reverse(), students: [...sample.students].reverse() };
  for (const date of ["2026-11-16", "2026-11-17", "2026-11-18"]) {
    assert.deepEqual(buildDailySchedule(reversed, date).routes, buildDailySchedule(sample, date).routes, date);
  }
});

test("students at a school with no dismissal time today are flagged, not dropped", () => {
  const data = fromRows({
    schools: [{ id: "x", name: "X School", dismissal_mon: null }],
    drivers: [{ id: "d1", name: "Ann", seats: 5, days: ["mon"] }],
    students: [{ id: "s1", name: "Leo", school_id: "x", days: ["mon"] }, { id: "s2", name: "Mia", school_id: "nope", days: ["mon"] }],
    travel: [],
    exceptions: [],
  });
  const s = buildDailySchedule(data, "2026-11-16");
  assert.deepEqual(s.unassigned.map((u) => u.name).sort(), ["Leo", "Mia"]);
  assert.equal(s.warnings.length, 2);
});
