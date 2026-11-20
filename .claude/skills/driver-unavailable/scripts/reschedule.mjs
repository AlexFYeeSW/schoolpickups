#!/usr/bin/env node
// Preview what happens when a driver can't work on a day: who takes their
// students, and whether everyone is still covered. READ-ONLY: never writes to
// the database. Prints the SQL to record the change for a person to run.
//
//   node .claude/skills/driver-unavailable/scripts/reschedule.mjs --driver "Driver B" --date tomorrow
//   node .claude/skills/driver-unavailable/scripts/reschedule.mjs --driver d2 --date 2026-11-23 --json
//
// --date accepts YYYY-MM-DD, today, tomorrow, or a weekday name (next one on or
// after today, America/Los_Angeles). Uses Supabase when SUPABASE_URL and
// SUPABASE_SECRET_KEY are set in the environment; otherwise the sample data.

import { loadData } from "../../../../src/db.js";
import { rescheduleWithoutDriver } from "../../../../src/reschedule.js";

const TZ = "America/Los_Angeles";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function resolveDate(input) {
  const today = todayLocal();
  const v = String(input || "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (v === "today") return today;
  if (v === "tomorrow") return addDays(today, 1);
  const idx = WEEKDAYS.findIndex((w) => w.startsWith(v) && v.length >= 3);
  if (idx !== -1) {
    const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, (idx - cur + 7) % 7);
  }
  throw new Error(`Can't understand date "${input}". Use YYYY-MM-DD, today, tomorrow or a weekday.`);
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const driverArg = arg("driver");
if (!driverArg || !arg("date")) {
  fail('Usage: reschedule.mjs --driver <id or name> --date <YYYY-MM-DD|today|tomorrow|weekday> [--json]');
}

let date;
try { date = resolveDate(arg("date")); } catch (e) { fail(e.message); }
const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
if (weekday === 0 || weekday === 6) fail(`${date} is a weekend; there are no pickups.`);
if (date < todayLocal()) fail(`${date} has already passed.`);

let data;
try {
  data = await loadData(process.env, todayLocal());
} catch (e) {
  fail(`Couldn't load data: ${e.message}`);
}

const q = driverArg.toLowerCase();
const matches = data.drivers.filter((d) => d.id.toLowerCase() === q || d.name.toLowerCase() === q);
const loose = matches.length ? matches : data.drivers.filter((d) => d.name.toLowerCase().includes(q));
if (loose.length === 0) fail(`No driver matches "${driverArg}". Drivers: ${data.drivers.map((d) => `${d.name} (${d.id})`).join(", ")}`);
if (loose.length > 1) fail(`"${driverArg}" matches several drivers: ${loose.map((d) => `${d.name} (${d.id})`).join(", ")}. Be more specific.`);
const driver = loose[0];

const result = rescheduleWithoutDriver(data, driver.id, date);
const alreadyRecorded = data.exceptions.some((e) => e.type === "driver_off" && e.driverId === driver.id && e.date === date);
const sql =
  `insert into exceptions (date, type, driver_id, confirmed, source_text)\n` +
  `values ('${date}', 'driver_off', '${driver.id.replace(/'/g, "''")}', true, 'Recorded via Claude Code');`;

if (process.argv.includes("--json")) {
  const { before, after, ...report } = result;
  console.log(JSON.stringify({ ...report, dataSource: data.source, alreadyRecorded, sql: alreadyRecorded ? null : sql, newRoutes: after.routes }, null, 2));
  process.exit(0);
}

const out = [];
out.push(`Data: ${data.source === "supabase" ? "Supabase (live)" : "SAMPLE data (Supabase not configured here)"}`);
out.push(`Date: ${date}   Driver: ${driver.name} (${driver.id})`);
out.push("");
out.push(result.summary);
if (result.moved.length) {
  out.push("", "Students moved:");
  for (const m of result.moved) {
    out.push(`  - ${m.student} (${m.school}) -> ${m.to ? `${m.to} at ${m.pickupTime}` : "NOT COVERED"}`);
  }
}
if (result.unassigned.length) {
  out.push("", "NOT COVERED:");
  for (const u of result.unassigned) out.push(`  - ${u.name} (${u.school})`);
}
if (result.warnings.length) {
  out.push("", "Warnings:");
  for (const w of result.warnings) out.push(`  - ${w}`);
}
out.push("", "New routes:");
for (const r of result.after.routes) {
  out.push(`  ${r.driverName} (${r.seats} seats)`);
  for (const s of r.stops) {
    out.push(`    ${s.time}  ${s.type === "pickup" ? "Pick up" : "Drop off"} at ${s.place} — ${s.students.length} student(s)`);
  }
}
out.push("");
out.push(
  alreadyRecorded
    ? "Already recorded in the database: the website already shows this schedule."
    : result.scheduledToWork
      ? `Not recorded yet. To record it (after confirming with the user), run in the Supabase SQL Editor:\n${sql}`
      : "Nothing to record.",
);
console.log(out.join("\n"));
