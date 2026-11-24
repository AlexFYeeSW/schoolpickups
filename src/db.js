// Read the app's data from Supabase (tables in supabase/schema.sql) through its
// REST API. Runs only on the server, with the secret key from the
// SUPABASE_SECRET_KEY Worker secret. The publishable key can't read these
// tables, because row-level security is on and no public policies exist.

import * as sample from "./sample-data.js";

const BASE = { id: "base", name: "Afterschool Center" };
const DAYS = ["mon", "tue", "wed", "thu", "fri"];

export class DbError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function secretKey(env) {
  return String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function baseUrl(env) {
  return String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}

/** "connected" | "needs-secret-key" | "not-configured" */
export function dbStatus(env) {
  if (!baseUrl(env)) return "not-configured";
  if (!secretKey(env)) return env.SUPABASE_PUBLISHABLE_KEY ? "needs-secret-key" : "not-configured";
  return "connected";
}

/** Call Supabase's REST API for one table. */
async function rest(env, table, { method = "GET", query = "", body, prefer } = {}) {
  const key = secretKey(env);
  const headers = { apikey: key, Accept: "application/json" };
  // Legacy keys are JWTs (eyJ…) and also go in Authorization; new sb_secret_ keys don't.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await fetch(`${baseUrl(env)}/rest/v1/${table}${query ? `?${query}` : ""}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new DbError(`Couldn't reach Supabase (${err?.message || "network error"}).`, 502);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.message || j.hint || j.error || text;
    } catch {}
    detail = String(detail).replace(/\s+/g, " ").slice(0, 160);
    console.error(`Supabase ${method} ${table} -> ${res.status}: ${detail}`);
    if (res.status === 401 || res.status === 403)
      throw new DbError(`Supabase refused the key (${res.status}). Use the secret key (sb_secret_…) in SUPABASE_SECRET_KEY. Supabase said: "${detail}"`, res.status);
    if (/column .* does not exist|could not find the .* column/i.test(detail))
      throw new DbError(`The "${table}" table is missing a newer column. Run supabase/schema.sql again in the Supabase SQL Editor (it's safe to re-run). Supabase said: "${detail}"`, res.status);
    if (res.status === 404 || /does not exist|schema cache/i.test(detail))
      throw new DbError(`The "${table}" table wasn't found. Run supabase/schema.sql in the Supabase SQL Editor. Supabase said: "${detail}"`, res.status);
    throw new DbError(`Supabase error ${res.status} on "${table}": "${detail}"`, res.status);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const select = (env, table, query = "select=*") => rest(env, table, { query });

/** Record that a driver won't work on a date (once; repeat calls do nothing). */
export async function markDriverOff(env, driverId, date, note) {
  const q = `driver_id=eq.${encodeURIComponent(driverId)}&date=eq.${date}&type=eq.driver_off`;
  const existing = await rest(env, "exceptions", { query: `select=id&${q}` });
  if (existing.length) {
    // Make sure it counts even if it was entered unconfirmed earlier.
    await rest(env, "exceptions", { method: "PATCH", query: q, body: { confirmed: true } });
    return { created: false };
  }
  await rest(env, "exceptions", {
    method: "POST",
    body: { date, type: "driver_off", driver_id: driverId, confirmed: true, source_text: note },
    prefer: "return=minimal",
  });
  return { created: true };
}

/** Undo: the driver can work on that date after all. */
export async function clearDriverOff(env, driverId, date) {
  const q = `driver_id=eq.${encodeURIComponent(driverId)}&date=eq.${date}&type=eq.driver_off`;
  const removed = await rest(env, "exceptions", { method: "DELETE", query: q, prefer: "return=representation" });
  return { removed: removed?.length ?? 0 };
}

/** "15:00:00" or "15:00" → 900 (minutes after midnight). */
export function toMinutes(t) {
  if (t == null || t === "") return undefined;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Turn Supabase rows into the shape the scheduler uses (same as sample-data.js). */
export function fromRows({ schools, drivers, students, travel, exceptions }) {
  const travelMinutes = {};
  for (const t of travel) {
    (travelMinutes[t.from_id] ??= {})[t.to_id] = t.minutes;
  }
  return {
    base: BASE,
    schools: schools.map((s) => ({
      id: s.id,
      name: s.name,
      dismissal: Object.fromEntries(DAYS.map((d) => [d, toMinutes(s[`dismissal_${d}`])])),
    })),
    drivers: drivers.map((d) => ({ id: d.id, name: d.name, seats: d.seats, days: d.days ?? DAYS })),
    students: students.map((s) => ({
      id: s.id,
      name: s.name,
      schoolId: s.school_id,
      days: s.days ?? DAYS,
      notes: s.notes || "",
    })),
    travelMinutes,
    exceptions: exceptions.map((e) => ({
      type: e.type,
      date: e.date,
      studentId: e.student_id ?? undefined,
      driverId: e.driver_id ?? undefined,
      schoolId: e.school_id ?? undefined,
      dismissal: toMinutes(e.dismissal),
    })),
  };
}

/**
 * Load everything the scheduler needs. Uses Supabase when connected; otherwise
 * the made-up sample data. `source` tells the page which one it is.
 */
export async function loadData(env, today) {
  const status = dbStatus(env);
  if (status !== "connected") return { ...sample, source: "sample", dbStatus: status };

  const from = shiftDate(today, -7);
  const to = shiftDate(today, 60);
  const [schools, drivers, students, travel, exceptions] = await Promise.all([
    select(env, "schools", "select=*&order=name"),
    // Filtered here rather than in the query so older databases without the
    // drivers.active column keep working.
    select(env, "drivers", "select=*&order=name").then((rows) => rows.filter((d) => d.active !== false)),
    select(env, "students", "select=*&active=eq.true&order=name"),
    select(env, "travel_times", "select=from_id,to_id,minutes"),
    select(env, "exceptions", `select=*&confirmed=eq.true&date=gte.${from}&date=lte.${to}`),
  ]);
  return { ...fromRows({ schools, drivers, students, travel, exceptions }), source: "supabase", dbStatus: status };
}

// ---------- driving times ----------

/** Schools with their addresses, for looking up driving times. */
export async function listSchoolAddresses(env) {
  return select(env, "schools", "select=id,name,address&order=name");
}

/** All saved driving times with where they came from and when. */
export async function listTravelTimes(env) {
  return select(env, "travel_times", "select=from_id,to_id,minutes,source,updated_at");
}

/** Insert or replace driving times. rows: [{ from_id, to_id, minutes }] */
export async function saveTravelTimes(env, rows, source = "google") {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await rest(env, "travel_times", {
    method: "POST",
    query: "on_conflict=from_id,to_id",
    body: rows.map((r) => ({ ...r, source, updated_at: now })),
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

// ---------- Manage page (drivers and students) ----------

export const listTable = (env, table, query) => select(env, table, query);

export async function insertRow(env, table, row) {
  await rest(env, table, { method: "POST", body: row, prefer: "return=minimal" });
}

/** Update one row by id; returns the updated rows (empty if not found). */
export async function updateRow(env, table, id, patch) {
  return rest(env, table, {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(id)}`,
    body: patch,
    prefer: "return=representation",
  });
}

/** How many successful driving-time refreshes happened since `sinceIso`. */
export async function countRefreshesSince(env, sinceIso) {
  const rows = await select(env, "travel_refreshes", `select=id&refreshed_at=gte.${encodeURIComponent(sinceIso)}`);
  return rows.length;
}

export async function logRefresh(env, routes, trigger) {
  await rest(env, "travel_refreshes", { method: "POST", body: { routes, trigger }, prefer: "return=minimal" });
}
