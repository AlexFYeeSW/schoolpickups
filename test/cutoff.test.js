import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { changesWindow, applyCutoff, validateChanges } from "../src/changes.js";
import * as sample from "../src/sample-data.js";
import worker from "../src/index.js";

const env = { TIMEZONE: "America/Los_Angeles" };
// Local Los Angeles time on a given November 2026 day (UTC-8).
const at = (day, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, day, h + 8, m)); // Date.UTC rolls over past midnight
};
const TUE = 24, WED = 25, SAT = 28, MON = 30;
const data = { ...sample, exceptions: [] };

test("cutoff is 45 minutes before the day's first dismissal", () => {
  // Sample data, Tuesday: Cedar Grove lets out first at 2:45 PM -> cutoff 2:00 PM.
  const tue = changesWindow(env, data, at(TUE, "13:59"));
  assert.equal(tue.firstDismissal, "2:45 PM");
  assert.equal(tue.cutoff, "2:00 PM");
  assert.equal(tue.minutesBefore, 45);
  assert.equal(tue.closedForToday, false);
  assert.equal(changesWindow(env, data, at(TUE, "14:00")).closedForToday, true);
  // Wednesday is an early day: Cedar Grove at 1:15 PM -> cutoff 12:30 PM.
  assert.equal(changesWindow(env, data, at(WED, "12:30")).cutoff, "12:30 PM");
  assert.equal(changesWindow(env, data, at(WED, "12:30")).closedForToday, true);
});

test("your West Covina times: 1:35 PM most days, 12:30 PM on Thursday", () => {
  const days = (mon, thu) => ({ mon, tue: mon, wed: mon, thu, fri: mon });
  const wc = { ...data, schools: data.schools.map((s) => ({ ...s, dismissal: days(860, 795) })) };
  assert.equal(changesWindow(env, wc, at(MON, "12:00")).cutoff, "1:35 PM");
  assert.equal(changesWindow(env, wc, at(26, "12:00")).cutoff, "12:30 PM"); // Thursday Nov 26
});

test("a saved early release today moves the cutoff earlier", () => {
  const early = { ...data, exceptions: [{ type: "dismissal_change", date: "2026-11-24", schoolId: "maple", dismissal: 720 }] };
  const w = changesWindow(env, early, at(TUE, "11:20"));
  assert.equal(w.firstDismissal, "12:00 PM");
  assert.equal(w.cutoff, "11:15 AM");
  assert.equal(w.closedForToday, true);
});

test("only schools with children being picked up count", () => {
  // Nobody at Cedar Grove today -> first dismissal is Maple/Hillcrest at 3:00 PM -> cutoff 2:15 PM.
  const noCedar = { ...data, students: data.students.filter((s) => s.schoolId !== "cedar") };
  assert.equal(changesWindow(env, noCedar, at(TUE, "12:00")).cutoff, "2:15 PM");
});

test("weekends never close; the lead time is a setting", () => {
  const sat = changesWindow(env, data, at(SAT, "23:00"));
  assert.equal(sat.cutoff, null);
  assert.equal(sat.closedForToday, false);
  const hour = changesWindow({ ...env, CHANGES_CUTOFF_MINUTES_BEFORE_DISMISSAL: "60" }, data, at(TUE, "13:50"));
  assert.equal(hour.cutoff, "1:45 PM");
  assert.equal(hour.closedForToday, true);
  assert.equal(changesWindow({ ...env, CHANGES_CUTOFF_MINUTES_BEFORE_DISMISSAL: "soon" }, data, at(TUE, "12:00")).minutesBefore, 45);
});

test("after the cutoff, today's changes are refused and later days still accepted", () => {
  const { valid } = validateChanges(sample, [
    { type: "student_absent", date: "2026-11-24", studentId: "s10" },
    { type: "driver_off", date: "2026-11-25", driverId: "d2" },
  ]);
  const result = { changes: valid, unclear: [], rejected: [] };
  assert.equal(applyCutoff(result, changesWindow(env, data, at(TUE, "13:00"))).changes.length, 2);
  const after = applyCutoff(result, changesWindow(env, data, at(TUE, "14:30")));
  assert.deepEqual(after.changes.map((c) => c.date), ["2026-11-25"]);
  assert.match(after.rejected[0].reason, /Leo .* absent .*changes for today closed at 2:00 PM\. Contact the driver directly\./);
});

// The parse route uses the server's clock (not the browser's "today") and reports the window.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("the Daily changes route ignores a 'today' sent by the browser", async () => {
  const fullEnv = { ...env, STAFF_PASSWORD: "pw", NVIDIA_API_KEY: "k", NVIDIA_MODEL: "m" };
  let systemPrompt = "";
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }));
    systemPrompt = JSON.parse(init.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"changes":[],"unclear":[]}' } }] }));
  };
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "pw" }) }), fullEnv);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const res = await worker.fetch(new Request("https://x/api/changes/parse", {
    method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ text: "Leo is out", today: "1999-01-01" }),
  }), fullEnv);
  const r = await res.json();
  const serverToday = changesWindow(env, data).today;
  assert.equal(r.window.today, serverToday);
  assert.ok(systemPrompt.includes(serverToday) && !systemPrompt.includes("1999-01-01"));
});
