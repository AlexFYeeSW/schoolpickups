// Manage drivers and students (the Manage page). Every change is checked here
// before it is written to Supabase.

import { listTable, insertRow, updateRow, dbStatus } from "./db.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri"];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function text(v, field, { required = false, max = 100 } = {}) {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v == null ? "" : null;
  if (s === null) throw new InputError(`${field} must be text.`);
  if (required && !s) throw new InputError(`${field} is required.`);
  if (s.length > max) throw new InputError(`${field} must be ${max} characters or fewer.`);
  return s || null;
}

function days(v) {
  if (!Array.isArray(v)) throw new InputError("Days must be a list of weekdays.");
  const list = DAYS.filter((d) => v.includes(d));
  if (list.length !== new Set(v).size) throw new InputError("Days can only be mon, tue, wed, thu, fri.");
  if (!list.length) throw new InputError("Pick at least one day.");
  return list;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Check and clean a driver. `partial` allows updating only some fields. */
export function cleanDriver(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || k in input;
  if (has("name")) out.name = text(input.name, "Name", { required: true });
  if (has("phone")) {
    out.phone = text(input.phone, "Phone", { max: 30 });
    if (out.phone && !/^[0-9+().\-\s]{7,30}$/.test(out.phone)) throw new InputError("Phone can only contain digits, spaces and + ( ) - .");
  }
  if (has("email")) {
    out.email = text(input.email, "Email", { max: 120 });
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new InputError("Email doesn't look right.");
  }
  if (has("seats")) {
    const n = Number(input.seats);
    if (!Number.isInteger(n) || n < 1 || n > 15) throw new InputError("Seats must be a whole number from 1 to 15.");
    out.seats = n;
  }
  if (has("days")) out.days = days(input.days);
  if (partial && "active" in input) {
    if (typeof input.active !== "boolean") throw new InputError("Active must be true or false.");
    out.active = input.active;
  }
  return out;
}

/** Check and clean a student. `schoolIds` = the schools that exist. */
export function cleanStudent(input, schoolIds, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || k in input;
  if (has("name")) out.name = text(input.name, "Name", { required: true });
  if (has("school_id")) {
    if (!schoolIds.has(input.school_id)) throw new InputError("Pick one of the listed schools.");
    out.school_id = input.school_id;
  }
  if (has("days")) out.days = days(input.days);
  if (has("notes")) out.notes = text(input.notes, "Notes", { max: 200 });
  if (has("guardian_contact")) out.guardian_contact = text(input.guardian_contact, "Guardian contact", { max: 200 });
  if (partial && "active" in input) {
    if (typeof input.active !== "boolean") throw new InputError("Active must be true or false.");
    out.active = input.active;
  }
  return out;
}

function requireDb(env) {
  if (dbStatus(env) !== "connected") {
    throw new InputError("The database isn't connected, so changes can't be saved. Add SUPABASE_SECRET_KEY in Cloudflare.");
  }
}

const STUDENT_COLS = "id,name,school_id,days,notes,guardian_contact,active";

export async function listDrivers(env) {
  requireDb(env);
  return listTable(env, "drivers", `select=*&order=name`).then((rows) =>
    rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, seats: r.seats, days: r.days, active: r.active !== false })),
  );
}

export async function listStudents(env) {
  requireDb(env);
  const [students, schools] = await Promise.all([
    listTable(env, "students", `select=${STUDENT_COLS}&order=name`),
    listTable(env, "schools", "select=id,name&order=name"),
  ]);
  return { students, schools };
}

export async function createDriver(env, input) {
  requireDb(env);
  const row = { id: newId("drv"), ...cleanDriver(input) };
  await insertRow(env, "drivers", row);
  return row;
}

export async function updateDriver(env, id, input) {
  requireDb(env);
  const patch = cleanDriver(input, { partial: true });
  if (!Object.keys(patch).length) throw new InputError("Nothing to change.");
  const rows = await updateRow(env, "drivers", id, patch);
  if (!rows.length) throw new InputError("That driver wasn't found.");
  return rows[0];
}

async function schoolIds(env) {
  return new Set((await listTable(env, "schools", "select=id")).map((s) => s.id));
}

export async function createStudent(env, input) {
  requireDb(env);
  const row = { id: newId("stu"), ...cleanStudent(input, await schoolIds(env)), active: true };
  await insertRow(env, "students", row);
  return row;
}

export async function updateStudent(env, id, input) {
  requireDb(env);
  const ids = "school_id" in input ? await schoolIds(env) : new Set();
  const patch = cleanStudent(input, ids, { partial: true });
  if (!Object.keys(patch).length) throw new InputError("Nothing to change.");
  const rows = await updateRow(env, "students", id, patch);
  if (!rows.length) throw new InputError("That student wasn't found.");
  return rows[0];
}
