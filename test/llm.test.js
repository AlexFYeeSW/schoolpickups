import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as sample from "../src/sample-data.js";
import { validateChanges, extractJson, parseChanges } from "../src/changes.js";
import { driverMessage } from "../src/llm.js";
import { buildDailySchedule } from "../src/scheduler.js";

const env = { NVIDIA_API_KEY: "test-key", NVIDIA_MODEL: "test-model" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeReply(content, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  };
  return calls;
}

test("validateChanges keeps good changes and rejects bad ones", () => {
  const { valid, rejected } = validateChanges(sample, [
    { type: "student_absent", date: "2026-11-19", studentId: "s10" },
    { type: "driver_off", date: "2026-11-18", driverId: "d2" },
    { type: "dismissal_change", date: "2026-11-19", schoolId: "maple", dismissal: "13:30" },
    { type: "student_absent", date: "2026-11-19", studentId: "nobody" },
    { type: "dismissal_change", date: "2026-11-19", schoolId: "maple", dismissal: "3:00" },
    { type: "cancel_everything", date: "2026-11-19" },
    { type: "driver_off", date: "tomorrow", driverId: "d1" },
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[2].dismissal, 810);
  assert.match(valid[0].summary, /Leo .* absent \(Thu 11-19\)/);
  assert.equal(rejected.length, 4);
});

test("extractJson handles code fences and extra words", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"changes":[],"unclear":["x"]}\n```'), { changes: [], unclear: ["x"] });
  assert.throws(() => extractJson("no json here"));
});

test("parseChanges sends the roster and returns checked changes", async () => {
  const calls = fakeReply(JSON.stringify({
    changes: [
      { type: "student_absent", date: "2026-11-19", studentId: "s10" },
      { type: "student_absent", date: "2026-11-19", studentId: "s99" },
    ],
    unclear: ["Two students are named Max"],
  }));
  const r = await parseChanges("Leo absent Thursday", sample, "2026-11-18", env);
  assert.equal(calls[0].auth, "Bearer test-key");
  assert.equal(calls[0].body.model, "test-model");
  assert.match(calls[0].body.messages[0].content, /Today is wed 2026-11-18/);
  assert.match(calls[0].body.messages[0].content, /s10 \| Leo/);
  assert.equal(r.changes.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.unclear, ["Two students are named Max"]);
});

test("parseChanges copes with an unreadable reply", async () => {
  fakeReply("I'm not sure what you mean.");
  const r = await parseChanges("hello", sample, "2026-11-18", env);
  assert.equal(r.changes.length, 0);
  assert.equal(r.unclear.length, 1);
});

test("applied changes affect the schedule", () => {
  const { valid } = validateChanges(sample, [{ type: "driver_off", date: "2026-11-16", driverId: "d2" }]);
  const s = buildDailySchedule({ ...sample, exceptions: valid }, "2026-11-16");
  assert.ok(!s.routes.some((r) => r.driverId === "d2"));
});

test("driverMessage uses AI text only if nothing went missing", async () => {
  const route = buildDailySchedule(sample, "2026-11-16").routes[0];
  const allNames = route.stops.flatMap((s) => [s.time, ...s.students.map((k) => k.name)]).join(" ");

  fakeReply(`Hi! Here's today: ${allNames}`);
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "nvidia");

  fakeReply("Hi! Short version with names left out.");
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "plain");

  fakeReply("error", 500);
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "plain");

  assert.equal((await driverMessage(route, "2026-11-16", {})).source, "plain");
});
