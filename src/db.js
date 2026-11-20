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

async function select(env, table, query = "select=*") {
  const key = secretKey(env);
  const headers = { apikey: key, Accept: "application/json" };
  // Legacy keys are JWTs (eyJ…) and also go in Authorization; new sb_secret_ keys don't.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;

  let res;
  try {
    res = await fetch(`${baseUrl(env)}/rest/v1/${table}?${query}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new DbError(`Couldn't reach Supabase (${err?.message || "network error"}).`, 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body;
    try {
      const j = JSON.parse(body);
      detail = j.message || j.hint || j.error || body;
    } catch {}
    detail = String(detail).replace(/\s+/g, " ").slice(0, 160);
    console.error(`Supabase ${table} -> ${res.status}: ${detail}`);
    if (res.status === 401 || res.status === 403)
      throw new DbError(`Supabase refused the key (${res.status}). Use the secret key (sb_secret_…) in SUPABASE_SECRET_KEY. Supabase said: "${detail}"`, res.status);
    if (res.status === 404 || /does not exist|schema cache/i.test(detail))
      throw new DbError(`The "${table}" table wasn't found. Run supabase/schema.sql in the Supabase SQL Editor. Supabase said: "${detail}"`, res.status);
    throw new DbError(`Supabase error ${res.status} reading "${table}": "${detail}"`, res.status);
  }
  return res.json();
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
    select(env, "drivers", "select=*&order=name"),
    select(env, "students", "select=*&active=eq.true&order=name"),
    select(env, "travel_times", "select=from_id,to_id,minutes"),
    select(env, "exceptions", `select=*&confirmed=eq.true&date=gte.${from}&date=lte.${to}`),
  ]);
  return { ...fromRows({ schools, drivers, students, travel, exceptions }), source: "supabase", dbStatus: status };
}
