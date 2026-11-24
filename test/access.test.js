// Who can see what: staff (logged in) vs. driver links vs. anyone.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// Sample data (no database), staff password set.
const env = { STAFF_PASSWORD: "pw-for-tests", TIMEZONE: "America/Los_Angeles", SEND_HOUR: "12" };
const MON = "2030-01-07"; // a future Monday

const req = (path, { method = "GET", body, cookie } = {}) =>
  new Request(`https://site.test${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function staffCookie() {
  const res = await worker.fetch(req("/api/login", { method: "POST", body: { password: env.STAFF_PASSWORD } }), env);
  return res.headers.get("Set-Cookie").split(";")[0];
}

test("old driver links (/?driver=…) forward to /schedule", async () => {
  const res = await worker.fetch(req("/?driver=d2&date=2030-01-07"), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://site.test/schedule?driver=d2&date=2030-01-07");
});

test("the full schedule needs a staff login", async () => {
  const anon = await worker.fetch(req("/api/schedule", { method: "POST", body: { date: MON } }), env);
  assert.equal(anon.status, 401);
  const staff = await worker.fetch(req("/api/schedule", { method: "POST", body: { date: MON }, cookie: await staffCookie() }), env);
  assert.equal(staff.status, 200);
  const s = await staff.json();
  assert.equal(s.routes.length, 4);
  assert.equal(staff.headers.get("Cache-Control"), "no-store");
});

test("a driver link gets only that driver's own route", async () => {
  const res = await worker.fetch(req("/api/schedule", { method: "POST", body: { date: MON, driverId: "d2" } }), env);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.deepEqual(s.routes.map((r) => r.driverId), ["d2"]);
  assert.deepEqual(s.unassigned, []);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.waits, undefined);
  // Unsaved "daily changes" can't be pushed through a driver link.
  const withChanges = await worker.fetch(req("/api/schedule", {
    method: "POST", body: { date: MON, driverId: "d2", changes: [{ type: "driver_off", date: MON, driverId: "d2" }] },
  }), env);
  assert.deepEqual((await withChanges.json()).routes.map((r) => r.driverId), ["d2"]);
  // An unknown driver id reveals nothing.
  const unknown = await (await worker.fetch(req("/api/schedule", { method: "POST", body: { date: MON, driverId: "nope" } }), env)).json();
  assert.deepEqual(unknown.routes, []);
});

test("staff tools need a staff login", async () => {
  const routes = [
    ["/api/changes/parse", "POST"], ["/api/ai-check", "GET"], ["/api/travel-times", "GET"],
    ["/api/travel-times/refresh", "POST"], ["/api/driver-message", "POST"], ["/api/schedule?format=text", "GET"],
  ];
  for (const [path, method] of routes) {
    const res = await worker.fetch(req(path, { method, body: method === "POST" ? { date: MON, text: "x", driverId: "d1" } : undefined }), env);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("a driver's day-off preview shows only the summary, not other children", async () => {
  const res = await worker.fetch(req("/api/driver-unavailable", { method: "POST", body: { date: MON, driverId: "d2", preview: true } }), env);
  const r = await res.json();
  assert.match(r.summary, /Driver B is off/);
  assert.equal(r.moved, undefined);
  assert.equal(r.unassigned, undefined);
  assert.equal(r.saved, false);
  // Staff see the details.
  const staff = await worker.fetch(req("/api/admin/days-off", {
    method: "POST", body: { date: MON, driverId: "d2", preview: true }, cookie: await staffCookie(),
  }), env);
  assert.ok((await staff.json()).moved.length > 0);
});

test("health check stays public and reveals no data", async () => {
  const res = await worker.fetch(req("/api/health"), env);
  assert.deepEqual(Object.keys(await res.json()).sort(), ["database", "llm", "ok"]);
});
