import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { checkPassword, sessionCookie, isStaff, staffLoginEnabled } from "../src/auth.js";
import { cleanDriver, cleanStudent } from "../src/admin.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const env = {
  STAFF_PASSWORD: "correct horse battery",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  TIMEZONE: "America/Los_Angeles",
};
const req = (path, { method = "GET", body, cookie } = {}) =>
  new Request(`https://site.test${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const cookieFrom = (res) => res.headers.get("Set-Cookie").split(";")[0];

// ---------- login ----------
test("editing is off until STAFF_PASSWORD is set", async () => {
  assert.equal(staffLoginEnabled({}), false);
  assert.equal(await checkPassword({}, ""), false);
  const res = await worker.fetch(req("/api/login", { method: "POST", body: { password: "x" } }), {});
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /STAFF_PASSWORD/);
});

test("right password logs in with a secure cookie; wrong one doesn't", async () => {
  const bad = await worker.fetch(req("/api/login", { method: "POST", body: { password: "nope" } }), env);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("Set-Cookie"), null);

  const ok = await worker.fetch(req("/api/login", { method: "POST", body: { password: env.STAFF_PASSWORD } }), env);
  assert.equal(ok.status, 200);
  const header = ok.headers.get("Set-Cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(header.includes(flag), flag);

  const session = await worker.fetch(req("/api/session", { cookie: cookieFrom(ok) }), env);
  assert.deepEqual(await session.json(), { enabled: true, loggedIn: true, database: "connected" });
});

test("sessions expire, can't be forged, and end when the password changes", async () => {
  const now = Date.now();
  const cookie = (await sessionCookie(env, now)).split(";")[0];
  const r = new Request("https://x", { headers: { Cookie: cookie } });
  assert.equal(await isStaff(r, env, now), true);
  assert.equal(await isStaff(r, env, now + 13 * 3_600_000), false, "expired after 12 hours");
  assert.equal(await isStaff(r, { ...env, STAFF_PASSWORD: "new password" }, now), false, "password changed");
  const forged = cookie.replace(/\d+\./, `${now + 999_999_999}.`);
  assert.equal(await isStaff(new Request("https://x", { headers: { Cookie: forged } }), env, now), false, "edited expiry");
});

test("admin routes need a login", async () => {
  globalThis.fetch = () => { throw new Error("must not reach Supabase"); };
  for (const [path, method] of [["/api/admin/drivers", "GET"], ["/api/admin/students", "POST"], ["/api/admin/drivers/drv_1", "PATCH"]]) {
    const res = await worker.fetch(req(path, { method, body: method === "GET" ? undefined : {} }), env);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

// ---------- input checks ----------
test("driver input is cleaned and checked", () => {
  assert.deepEqual(
    cleanDriver({ name: "  Ann   Lee ", seats: "7", phone: "(213) 555-0100", email: "ann@example.com", days: ["fri", "mon"] }),
    { name: "Ann Lee", seats: 7, phone: "(213) 555-0100", email: "ann@example.com", days: ["mon", "fri"] },
  );
  const base = { name: "Ann", seats: 6, days: ["mon"] };
  assert.throws(() => cleanDriver({ ...base, name: " " }), /Name is required/);
  assert.throws(() => cleanDriver({ ...base, seats: 0 }), /Seats must be/);
  assert.throws(() => cleanDriver({ ...base, seats: 2.5 }), /Seats must be/);
  assert.throws(() => cleanDriver({ ...base, seats: 16 }), /Seats must be/);
  assert.throws(() => cleanDriver({ ...base, email: "not-an-email" }), /Email/);
  assert.throws(() => cleanDriver({ ...base, phone: "call me" }), /Phone/);
  assert.throws(() => cleanDriver({ ...base, days: [] }), /at least one day/);
  assert.throws(() => cleanDriver({ ...base, days: ["sat"] }), /only be mon/);
  assert.deepEqual(cleanDriver({ active: false }, { partial: true }), { active: false });
});

test("student input is cleaned and checked", () => {
  const schools = new Set(["maple"]);
  assert.deepEqual(
    cleanStudent({ name: "Leo", school_id: "maple", days: ["mon"], notes: "", guardian_contact: "Mom 555-0100" }, schools),
    { name: "Leo", school_id: "maple", days: ["mon"], notes: null, guardian_contact: "Mom 555-0100" },
  );
  assert.throws(() => cleanStudent({ name: "Leo", school_id: "nope", days: ["mon"] }, schools), /listed schools/);
  assert.throws(() => cleanStudent({ name: "Leo", school_id: "maple", days: ["mon"], notes: "x".repeat(201) }, schools), /200 characters/);
});

// ---------- saving through the API (fake Supabase) ----------
test("logged-in staff can add and update records", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || "GET", path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (u.pathname.endsWith("/schools")) return new Response(JSON.stringify([{ id: "maple", name: "Maple" }]));
    if (call.method === "PATCH") return new Response(JSON.stringify([{ id: "stu_1", ...call.body }]));
    if (call.method === "POST") return new Response("", { status: 201 });
    return new Response(JSON.stringify([{ id: "d1", name: "Ann", seats: 6, days: ["mon"] }]));
  };
  const login = await worker.fetch(req("/api/login", { method: "POST", body: { password: env.STAFF_PASSWORD } }), env);
  const cookie = cookieFrom(login);

  const list = await worker.fetch(req("/api/admin/drivers", { cookie }), env);
  assert.equal(list.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await list.json()).drivers[0], { id: "d1", name: "Ann", seats: 6, days: ["mon"], active: true });

  const add = await worker.fetch(req("/api/admin/drivers", { method: "POST", cookie, body: { name: "Bo", seats: 5, days: ["tue"] } }), env);
  assert.equal(add.status, 201);
  const insert = calls.find((c) => c.method === "POST" && c.path === "/rest/v1/drivers");
  assert.match(insert.body.id, /^drv_[0-9a-f]{10}$/);
  assert.equal(insert.body.name, "Bo");

  const bad = await worker.fetch(req("/api/admin/students", { method: "POST", cookie, body: { name: "Leo", school_id: "nope", days: ["mon"] } }), env);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /listed schools/);

  const upd = await worker.fetch(req("/api/admin/students/stu_1", { method: "PATCH", cookie, body: { active: false } }), env);
  assert.equal(upd.status, 200);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/rest/v1/students?id=eq.stu_1");
  assert.deepEqual(patch.body, { active: false });
});
