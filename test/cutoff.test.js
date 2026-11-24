import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { changesWindow, applyCutoff, validateChanges } from "../src/changes.js";
import * as sample from "../src/sample-data.js";
import worker from "../src/index.js";

const env = { TIMEZONE: "America/Los_Angeles", CHANGES_CUTOFF: "13:30" };
// 2026-11-24 is a Tuesday; Los Angeles is UTC-8 in November.
const at = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 24, h + 8, m)); // Date.UTC rolls 24:45 over to the next day
};

test("changes for today are open until 1:30 PM Los Angeles time", () => {
  assert.deepEqual(changesWindow(env, at("13:29")), { today: "2026-11-24", cutoff: "1:30 PM", closedForToday: false });
  assert.equal(changesWindow(env, at("13:30")).closedForToday, true);
  assert.equal(changesWindow(env, at("16:45")).closedForToday, true);
  assert.equal(changesWindow(env, at("08:00")).closedForToday, false);
});

test("the cutoff time is a setting, with a safe default", () => {
  assert.equal(changesWindow({ ...env, CHANGES_CUTOFF: "12:00" }, at("12:05")).closedForToday, true);
  assert.equal(changesWindow({ ...env, CHANGES_CUTOFF: "nonsense" }, at("13:29")).cutoff, "1:30 PM");
  assert.equal(changesWindow({ TIMEZONE: env.TIMEZONE }, at("13:31")).closedForToday, true);
});

test("after the cutoff, today's changes are refused and later days still accepted", () => {
  const { valid } = validateChanges(sample, [
    { type: "student_absent", date: "2026-11-24", studentId: "s10" },
    { type: "driver_off", date: "2026-11-25", driverId: "d2" },
  ]);
  const result = { changes: valid, unclear: [], rejected: [] };

  const before = applyCutoff(result, changesWindow(env, at("13:00")));
  assert.equal(before.changes.length, 2);

  const after = applyCutoff(result, changesWindow(env, at("14:00")));
  assert.deepEqual(after.changes.map((c) => c.date), ["2026-11-25"]);
  assert.equal(after.rejected.length, 1);
  assert.match(after.rejected[0].reason, /Leo .* absent .*changes for today closed at 1:30 PM\. Contact the driver directly\./);
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
  const serverToday = changesWindow(env).today;
  assert.equal(r.window.today, serverToday);
  assert.ok(systemPrompt.includes(serverToday) && !systemPrompt.includes("1999-01-01"));
});
