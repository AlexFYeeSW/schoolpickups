// Driving times from the Google Routes API (computeRouteMatrix), with traffic,
// saved into the Supabase travel_times table that the scheduler reads.
// Only addresses of the center and schools are sent to Google.
//
// Needs: GOOGLE_MAPS_API_KEY (secret), CENTER_ADDRESS (variable), the
// database connected, and an address on each school.

import { listSchoolAddresses, listTravelTimes, saveTravelTimes, dbStatus, countRefreshesSince, logRefresh, DbError } from "./db.js";

const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const DEFAULT_REFRESHES_PER_DAY = 10; // keeps Google costs down; TRAVEL_REFRESHES_PER_DAY overrides

export function refreshesPerDay(env) {
  const n = Number(env.TRAVEL_REFRESHES_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_REFRESHES_PER_DAY;
}

/** Midnight today in the business's time zone, as a UTC Date. */
function startOfLocalDay(timeZone, now) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  return zonedTime(today, "00:00", timeZone);
}
const DEFAULT_DEPARTURE = "15:00"; // weekday afternoon pickup traffic

export class MapsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function mapsKey(env) {
  return String(env.GOOGLE_MAPS_API_KEY || "").trim();
}

/** Convert a local wall-clock time in `timeZone` to a UTC Date. */
export function zonedTime(dateStr, hhmm, timeZone) {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  // How far is the zone from UTC at that moment? Adjust twice for DST edges.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
    );
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    ts += guess - shown;
  }
  return new Date(ts);
}

/** Next Monday–Friday at `hhmm` local time that is still in the future. */
export function nextWeekdayDeparture(timeZone, hhmm = DEFAULT_DEPARTURE, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  for (let i = 0; i < 8; i++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const at = zonedTime(dateStr, hhmm, timeZone);
    if (at.getTime() > now.getTime() + 5 * 60_000) return { date: dateStr, at };
  }
  throw new Error("Couldn't find a weekday departure time");
}

// Google's machine-readable reasons (ErrorInfo.reason) → what to fix.
const REASON_HELP = {
  API_KEY_INVALID: "The API key isn't valid. Check the GOOGLE_MAPS_API_KEY secret in Cloudflare.",
  SERVICE_DISABLED: "The Routes API isn't turned on in the Google Cloud project that owns this key. Open that project → APIs & Services → Library → Routes API → Enable, then wait a few minutes.",
  API_KEY_SERVICE_BLOCKED: "The key's API restrictions don't allow the Routes API. In Google Cloud → APIs & Services → Credentials → this key → API restrictions, tick Routes API and save, then wait a few minutes.",
  BILLING_DISABLED: "Billing isn't turned on for the Google Cloud project that owns this key. Link a billing account to that project.",
  API_KEY_HTTP_REFERRER_BLOCKED: "The key only allows certain websites. Set Application restrictions to None (the requests come from Cloudflare's servers, not a browser).",
  API_KEY_IP_ADDRESS_BLOCKED: "The key only allows certain IP addresses. Set Application restrictions to None (Cloudflare's server addresses change).",
  CONSUMER_INVALID: "The Google Cloud project that owns this key can't be used (it may be deleted or suspended).",
  RATE_LIMIT_EXCEEDED: "Google's usage limit for this key was reached. Try again later or raise the quota.",
};

function friendly(status, message, reason) {
  const said = message ? ` Google said: "${message}"` : "";
  const code = reason ? ` [${reason}]` : "";
  if (reason && REASON_HELP[reason]) return `${REASON_HELP[reason]}${said}${code}`;
  if (status === 400) return `Google rejected the request (400). An address may be invalid.${said}${code}`;
  if (status === 401 || status === 403)
    return `Google refused the API key (${status}). Most often: the key's API restrictions don't include Routes API, or the Routes API is enabled in a different project than the key's. Also check billing is on.${said}${code}`;
  if (status === 429) return `Google's usage limit was reached (429). Try again later.${code}`;
  return `Google Routes returned an error (${status}).${said}${code}`;
}

/** Durations like "534s" → whole minutes, rounded up. */
export function toMinutesFromDuration(d) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || ""));
  return m ? Math.max(1, Math.ceil(Number(m[1]) / 60)) : null;
}

// A traffic-aware matrix request may hold at most 100 routes (origins x destinations).
const MAX_ROUTES_PER_REQUEST = 100;

/** One computeRouteMatrix call. Returns Google's list of route results. */
async function requestMatrix(key, origins, destinations, departure) {
  let res;
  try {
    res = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition,status",
      },
      body: JSON.stringify({
        origins: origins.map((p) => ({ waypoint: { address: p.address } })),
        destinations: destinations.map((p) => ({ waypoint: { address: p.address } })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
        departureTime: departure.toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MapsError(`Couldn't reach Google (${err?.message || "network error"}).`, 502);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MapsError(`Google sent back a reply that couldn't be read (${res.status}).`, 502);
  }
  // computeRouteMatrix streams its reply, so errors arrive wrapped in a list:
  // [{"error": {...}}]. Accept both shapes.
  const errObj = Array.isArray(body) ? body.find((x) => x?.error)?.error : body?.error;
  if (!res.ok || errObj) {
    const status = errObj?.code || res.status;
    const msg = String(errObj?.message || "").replace(/\s+/g, " ").slice(0, 200);
    const reason = errObj?.details?.find((d) => d?.reason)?.reason;
    console.error(`Google Routes -> ${status} ${reason || ""}: ${msg}`);
    throw new MapsError(friendly(status, msg, reason), status);
  }
  return Array.isArray(body) ? body : [];
}

/**
 * Ask Google for driving minutes between every pair of places, splitting the
 * work into several requests when there are more than 10 places.
 * places: [{ id, name, address }]. Returns { rows: [{from_id,to_id,minutes}], problems: [] }.
 */
export async function fetchDrivingMatrix(env, places, departure) {
  const key = mapsKey(env);
  if (!key) throw new MapsError("GOOGLE_MAPS_API_KEY isn't set on the Worker.", 503);
  if (places.length < 2) throw new MapsError("Need at least the center and one school with an address.", 400);
  if (places.length > MAX_ROUTES_PER_REQUEST) throw new MapsError(`Too many places (max ${MAX_ROUTES_PER_REQUEST}).`, 400);

  const originsPerRequest = Math.floor(MAX_ROUTES_PER_REQUEST / places.length);
  const rows = [];
  const problems = [];
  for (let start = 0; start < places.length; start += originsPerRequest) {
    const origins = places.slice(start, start + originsPerRequest);
    const results = await requestMatrix(key, origins, places, departure);
    for (const el of results) {
      const from = origins[el.originIndex];
      const to = places[el.destinationIndex];
      if (!from || !to || from.id === to.id) continue;
      const minutes = toMinutesFromDuration(el.duration);
      if (el.status?.code || el.condition === "ROUTE_NOT_FOUND" || minutes == null) {
        problems.push(`${from.name} → ${to.name}: ${el.status?.message || el.condition || "no route found"}`);
        continue;
      }
      rows.push({ from_id: from.id, to_id: to.id, minutes });
    }
  }
  return { rows, problems };
}

/** What's saved now, and whether a refresh is possible. For the staff page. */
export async function travelStatus(env, now = new Date()) {
  const base = {
    googleKey: Boolean(mapsKey(env)),
    centerAddress: Boolean(String(env.CENTER_ADDRESS || "").trim()),
    database: dbStatus(env),
  };
  if (base.database !== "connected") return { ...base, canRefresh: false, reason: "The database isn't connected." };

  const [schools, times] = await Promise.all([listSchoolAddresses(env), listTravelTimes(env)]);
  const google = times.filter((t) => t.source === "google");
  const lastGoogle = google.map((t) => t.updated_at).sort().pop() || null;
  const perDay = refreshesPerDay(env);
  let refreshesToday = null;
  let logMissing = false;
  try {
    refreshesToday = await countRefreshesSince(env, startOfLocalDay(env.TIMEZONE, now).toISOString());
  } catch (err) {
    if (!(err instanceof DbError)) throw err;
    logMissing = true; // older database without the travel_refreshes table
  }
  const missingAddresses = schools.filter((s) => !String(s.address || "").trim()).map((s) => s.name);

  // Setup problems block every refresh; "too recent" only blocks the manual button.
  let setupProblem = null;
  if (!base.googleKey) setupProblem = "Add the GOOGLE_MAPS_API_KEY secret in Cloudflare.";
  else if (!base.centerAddress) setupProblem = "Add the CENTER_ADDRESS variable in Cloudflare (the afterschool center's street address).";
  else if (missingAddresses.length === schools.length) setupProblem = "Add an address to each school in the Supabase schools table.";
  else if (logMissing) setupProblem = "Run supabase/schema.sql again in the Supabase SQL Editor (it adds the travel_refreshes table used for the daily limit; safe to re-run).";
  const limitReached = refreshesToday != null && refreshesToday >= perDay;
  const reason = setupProblem || (limitReached ? `Driving times were already refreshed ${refreshesToday} times today (the limit is ${perDay}). Try again tomorrow.` : null);

  return {
    ...base,
    pairs: times.length,
    fromGoogle: google.length,
    lastUpdatedFromGoogle: lastGoogle,
    refreshesToday,
    refreshesPerDay: perDay,
    missingAddresses,
    canRefresh: !reason,
    setupProblem,
    reason,
  };
}

/**
 * Look up driving times for the center and every school with an address, and
 * save them. Limited to TRAVEL_REFRESHES_PER_DAY successful refreshes per local
 * day (default 10) unless `force` (used by the weekly job). Failed attempts
 * don't count: Google doesn't charge for refused requests.
 */
export async function refreshTravelTimes(env, { force = false, now = new Date() } = {}) {
  const status = await travelStatus(env, now);
  if (status.database !== "connected") throw new MapsError(status.reason, 503);
  if (status.setupProblem) throw new MapsError(status.setupProblem, 409);
  if (!status.canRefresh && !force) throw new MapsError(status.reason, 429);

  const schools = (await listSchoolAddresses(env)).filter((s) => String(s.address || "").trim());
  const places = [
    { id: "base", name: "Afterschool Center", address: String(env.CENTER_ADDRESS).trim() },
    ...schools.map((s) => ({ id: s.id, name: s.name, address: s.address.trim() })),
  ];
  const departure = nextWeekdayDeparture(env.TIMEZONE, env.TRAFFIC_DEPARTURE || DEFAULT_DEPARTURE, now);
  const { rows, problems } = await fetchDrivingMatrix(env, places, departure.at);
  if (!rows.length) throw new MapsError(`Google returned no usable routes. ${problems.join("; ")}`, 502);

  await saveTravelTimes(env, rows, "google");
  await logRefresh(env, rows.length, force ? "weekly" : "manual");
  const summary = `Updated ${rows.length} driving times from Google for traffic on ${departure.date} at ${env.TRAFFIC_DEPARTURE || DEFAULT_DEPARTURE}.`;
  console.log(summary, problems.length ? `Problems: ${problems.join("; ")}` : "");
  return {
    updated: rows.length,
    trafficFor: `${departure.date} ${env.TRAFFIC_DEPARTURE || DEFAULT_DEPARTURE}`,
    problems,
    skippedSchools: status.missingAddresses,
    summary,
  };
}
