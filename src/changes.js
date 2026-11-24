// Step 1: turn free-text daily changes ("Leo absent Thursday") into structured
// change records. The LLM proposes; this file checks every field against the
// real data, and staff confirm before anything is applied.

import { chat, llmEnabled } from "./llm.js";
import { weekdayOf, buildRoster } from "./scheduler.js";
import { localNow, clockLabel } from "./time.js";

export const MAX_TEXT_LENGTH = 2000;
const TYPES = ["student_absent", "driver_off", "dismissal_change", "extra_pickup"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Check a list of change records against the data. Returns the valid ones
 * (normalized, with a human-readable summary) and a reason for each rejected one.
 */
export function validateChanges(data, list) {
  const valid = [];
  const rejected = [];
  const student = new Map(data.students.map((s) => [s.id, s]));
  const driver = new Map(data.drivers.map((d) => [d.id, d]));
  const school = new Map(data.schools.map((s) => [s.id, s]));

  for (const c of Array.isArray(list) ? list : []) {
    const why = (reason) => rejected.push({ change: c, reason });
    if (!c || typeof c !== "object") { why("not an object"); continue; }
    if (!TYPES.includes(c.type)) { why(`unknown type "${c.type}"`); continue; }
    if (!DATE_RE.test(c.date ?? "") || Number.isNaN(Date.parse(c.date))) { why("bad date"); continue; }

    if (c.type === "student_absent" || c.type === "extra_pickup") {
      const s = student.get(c.studentId);
      if (!s) { why("unknown student"); continue; }
      const verb = c.type === "student_absent" ? "absent" : "extra pickup";
      valid.push({ type: c.type, date: c.date, studentId: s.id, summary: `${s.name} — ${verb} (${label(c.date)})` });
    } else if (c.type === "driver_off") {
      const d = driver.get(c.driverId);
      if (!d) { why("unknown driver"); continue; }
      valid.push({ type: c.type, date: c.date, driverId: d.id, summary: `${d.name} — off (${label(c.date)})` });
    } else {
      const s = school.get(c.schoolId);
      if (!s) { why("unknown school"); continue; }
      let minutes = c.dismissal;
      if (typeof minutes === "string") {
        const m = TIME_RE.exec(minutes);
        minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
      }
      if (!Number.isInteger(minutes) || minutes < 600 || minutes > 1140) {
        why("dismissal time missing or outside 10 AM–7 PM");
        continue;
      }
      valid.push({
        type: c.type, date: c.date, schoolId: s.id, dismissal: minutes,
        summary: `${s.name} — dismissal ${fmt(minutes)} (${label(c.date)})`,
      });
    }
  }
  return { valid, rejected };
}

function label(date) {
  return `${weekdayOf(date).replace(/^./, (x) => x.toUpperCase())} ${date.slice(5)}`;
}
function fmt(min) {
  const h = Math.floor(min / 60);
  return `${((h + 11) % 12) + 1}:${String(min % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** Pull the first JSON object out of a model reply (models sometimes add prose or ``` fences). */
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

/** Ask the LLM to read the message. Returns { changes, unclear, rejected }. */
export async function parseChanges(text, data, today, env) {
  if (!llmEnabled(env)) throw new Error("The Nvidia API key is not set up (NVIDIA_API_KEY).");

  const roster = [
    "STUDENTS (id | name | school):",
    ...data.students.map((s) => `${s.id} | ${s.name} | ${s.schoolId}`),
    "DRIVERS (id | name):",
    ...data.drivers.map((d) => `${d.id} | ${d.name}`),
    "SCHOOLS (id | name):",
    ...data.schools.map((s) => `${s.id} | ${s.name}`),
  ].join("\n");

  const system = `You read messages to an afterschool pickup service and extract schedule changes.
Today is ${weekdayOf(today)} ${today}. A weekday name means the next such day on or after today.
"Today" and "tomorrow" are relative to ${today}. Pickups only happen Monday-Friday.

Reply with ONLY a JSON object, no other text:
{"changes":[...], "unclear":["..."]}

Each change is one of:
{"type":"student_absent","date":"YYYY-MM-DD","studentId":"<id>"}
{"type":"extra_pickup","date":"YYYY-MM-DD","studentId":"<id>"}
{"type":"driver_off","date":"YYYY-MM-DD","driverId":"<id>"}
{"type":"dismissal_change","date":"YYYY-MM-DD","schoolId":"<id>","dismissal":"HH:MM"}   (24-hour time)

Only use ids from the lists below. If a name matches more than one person, or no one,
or the request is not one of these types, do not guess: put a short note in "unclear".
A change that covers several days becomes one entry per day.

${roster}`;

  const { text: reply } = await chat(env, system, text.slice(0, MAX_TEXT_LENGTH), { maxTokens: 3000, temperature: 0 });
  let parsed;
  try {
    parsed = extractJson(reply);
  } catch {
    return { changes: [], unclear: ["The AI reply couldn't be read. Try rewording the message."], rejected: [] };
  }
  const { valid, rejected } = validateChanges(data, parsed.changes);
  const unclear = (Array.isArray(parsed.unclear) ? parsed.unclear : []).filter((u) => typeof u === "string").slice(0, 20);
  return { changes: valid, unclear, rejected };
}

// ---------- same-day cutoff ----------

export const DEFAULT_MINUTES_BEFORE_DISMISSAL = 45;

/** Minutes before the first dismissal that same-day changes stop (CHANGES_CUTOFF_MINUTES_BEFORE_DISMISSAL). */
function leadMinutes(env) {
  const n = Number(env.CHANGES_CUTOFF_MINUTES_BEFORE_DISMISSAL);
  return Number.isInteger(n) && n >= 0 && n <= 600 ? n : DEFAULT_MINUTES_BEFORE_DISMISSAL;
}

/**
 * Whether the Daily changes box still accepts changes for today. Same-day
 * changes close a set number of minutes (default 45) before the earliest
 * dismissal today — counting saved early-release changes — among schools with
 * students being picked up (or any school with a time, if none). Changes for
 * later days are always accepted. Days without dismissal times never close.
 */
export function changesWindow(env, data, now = new Date()) {
  const t = localNow(env.TIMEZONE, now);
  const lead = leadMinutes(env);
  const roster = buildRoster(data, t.date);
  const withStudents = new Set(roster.students.map((s) => s.schoolId));
  const times = (list) => list.map((s) => s.dismissalToday).filter((m) => Number.isFinite(m));
  const pool = times(roster.schools.filter((s) => withStudents.has(s.id)));
  const firstDismissal = Math.min(...(pool.length ? pool : times(roster.schools)));

  if (!Number.isFinite(firstDismissal)) {
    return { today: t.date, cutoff: null, cutoffMinutes: null, firstDismissal: null, minutesBefore: lead, closedForToday: false };
  }
  const cutoffMinutes = Math.max(0, firstDismissal - lead);
  return {
    today: t.date,
    cutoff: clockLabel(cutoffMinutes),
    cutoffMinutes,
    firstDismissal: clockLabel(firstDismissal),
    minutesBefore: lead,
    closedForToday: t.hour * 60 + t.minute >= cutoffMinutes,
  };
}

/** Move changes for today into `rejected` once today's window has closed. */
export function applyCutoff(result, window) {
  if (!window.closedForToday) return result;
  const late = result.changes.filter((c) => c.date === window.today);
  if (!late.length) return result;
  return {
    ...result,
    changes: result.changes.filter((c) => c.date !== window.today),
    rejected: [
      ...result.rejected,
      ...late.map((c) => ({
        change: c,
        reason: `${c.summary}: changes for today closed at ${window.cutoff}. Contact the driver directly.`,
      })),
    ],
  };
}
