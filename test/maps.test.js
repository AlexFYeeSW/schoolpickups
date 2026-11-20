import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  zonedTime, nextWeekdayDeparture, toMinutesFromDuration, fetchDrivingMatrix, refreshTravelTimes, travelStatus,
} from "../src/maps.js";

const TZ = "America/Los_Angeles";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("local 3 PM in Los Angeles converts to UTC in winter and summer", () => {
  assert.equal(zonedTime("2026-11-23", "15:00", TZ).toISOString(), "2026-11-23T23:00:00.000Z"); // PST
  assert.equal(zonedTime("2026-07-15", "15:00", TZ).toISOString(), "2026-07-15T22:00:00.000Z"); // PDT
});

test("departure is the next weekday afternoon still in the future", () => {
  // Friday 10 AM LA -> same Friday 3 PM
  assert.equal(nextWeekdayDeparture(TZ, "15:00", new Date("2026-11-20T18:00:00Z")).date, "2026-11-20");
  // Friday 4 PM LA -> Monday 3 PM
  const r = nextWeekdayDeparture(TZ, "15:00", new Date("2026-11-21T00:00:00Z"));
  assert.equal(r.date, "2026-11-23");
  assert.equal(r.at.toISOString(), "2026-11-23T23:00:00.000Z");
  // Saturday -> Monday
  assert.equal(nextWeekdayDeparture(TZ, "15:00", new Date("2026-11-21T20:00:00Z")).date, "2026-11-23");
});

test("durations round up to whole minutes", () => {
  assert.equal(toMinutesFromDuration("534s"), 9);
  assert.equal(toMinutesFromDuration("600s"), 10);
  assert.equal(toMinutesFromDuration("bad"), null);
});

const places = [
  { id: "base", name: "Center", address: "1 Main St" },
  { id: "maple", name: "Maple", address: "2 Oak Ave" },
  { id: "cedar", name: "Cedar", address: "3 Elm Rd" },
];

test("asks Google for a traffic-aware matrix and reads the reply", async () => {
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url, headers: init.headers, body: JSON.parse(init.body) };
    return json([
      { originIndex: 0, destinationIndex: 0, duration: "0s", condition: "ROUTE_EXISTS" },
      { originIndex: 0, destinationIndex: 1, duration: "534s", condition: "ROUTE_EXISTS" },
      { originIndex: 1, destinationIndex: 0, duration: "600s", condition: "ROUTE_EXISTS" },
      { originIndex: 1, destinationIndex: 2, condition: "ROUTE_NOT_FOUND" },
      { originIndex: 2, destinationIndex: 1, status: { code: 3, message: "Address not found" } },
    ]);
  };
  const departure = new Date("2026-11-23T23:00:00Z");
  const r = await fetchDrivingMatrix({ GOOGLE_MAPS_API_KEY: "test-key" }, places, departure);

  assert.equal(call.url, "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix");
  assert.equal(call.headers["X-Goog-Api-Key"], "test-key");
  assert.match(call.headers["X-Goog-FieldMask"], /duration/);
  assert.equal(call.body.travelMode, "DRIVE");
  assert.equal(call.body.routingPreference, "TRAFFIC_AWARE_OPTIMAL");
  assert.equal(call.body.departureTime, "2026-11-23T23:00:00.000Z");
  assert.deepEqual(call.body.origins[1], { waypoint: { address: "2 Oak Ave" } });

  assert.deepEqual(r.rows, [
    { from_id: "base", to_id: "maple", minutes: 9 },
    { from_id: "maple", to_id: "base", minutes: 10 },
  ]);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems.join(" "), /Maple → Cedar: ROUTE_NOT_FOUND/);
  assert.match(r.problems.join(" "), /Address not found/);
});

test("a refused Google key gives a clear message", async () => {
  globalThis.fetch = async () => json({ error: { code: 403, message: "Routes API has not been used in project 123" } }, 403);
  await assert.rejects(
    fetchDrivingMatrix({ GOOGLE_MAPS_API_KEY: "k" }, places, new Date()),
    /refused the API key \(403\).*Routes API is enabled.*has not been used/,
  );
});

// ---- full refresh with a fake Supabase + Google ----
function fakeServices({ schools, times = [] }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname + u.search, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined, prefer: init.headers?.Prefer });
    if (u.host === "routes.googleapis.com") {
      const n = JSON.parse(init.body).origins.length;
      const out = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push({ originIndex: i, destinationIndex: j, duration: `${(i + j + 1) * 60}s`, condition: "ROUTE_EXISTS" });
      return json(out);
    }
    if (u.pathname.endsWith("/schools")) return json(schools);
    if (u.pathname.endsWith("/travel_times") && (init.method || "GET") === "GET") return json(times);
    return new Response("", { status: 201 });
  };
  return calls;
}

const env = {
  SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x",
  GOOGLE_MAPS_API_KEY: "g-key", CENTER_ADDRESS: "1 Main St", TIMEZONE: TZ, TRAFFIC_DEPARTURE: "15:00",
};
const NOW = new Date("2026-11-20T18:00:00Z");

test("refresh saves Google times for the center and schools with addresses", async () => {
  const calls = fakeServices({ schools: [
    { id: "maple", name: "Maple", address: "2 Oak Ave" },
    { id: "cedar", name: "Cedar", address: "" },
  ] });
  const r = await refreshTravelTimes(env, { now: NOW });
  assert.equal(r.updated, 2); // base<->maple
  assert.deepEqual(r.skippedSchools, ["Cedar"]);
  assert.equal(r.trafficFor, "2026-11-20 15:00");

  const save = calls.find((c) => c.method === "POST" && c.path.startsWith("/rest/v1/travel_times"));
  assert.match(save.path, /on_conflict=from_id,to_id/);
  assert.match(save.prefer, /resolution=merge-duplicates/);
  assert.deepEqual(save.body.map((b) => [b.from_id, b.to_id, b.source]), [["base", "maple", "google"], ["maple", "base", "google"]]);
  const google = calls.find((c) => c.host === "routes.googleapis.com");
  assert.deepEqual(google.body.origins.map((o) => o.waypoint.address), ["1 Main St", "2 Oak Ave"]);
});

test("setup problems are explained", async () => {
  fakeServices({ schools: [{ id: "maple", name: "Maple", address: "2 Oak Ave" }] });
  await assert.rejects(refreshTravelTimes({ ...env, GOOGLE_MAPS_API_KEY: "" }, { now: NOW }), /GOOGLE_MAPS_API_KEY/);
  await assert.rejects(refreshTravelTimes({ ...env, CENTER_ADDRESS: "" }, { now: NOW }), /CENTER_ADDRESS/);
  fakeServices({ schools: [{ id: "maple", name: "Maple", address: null }] });
  await assert.rejects(refreshTravelTimes(env, { now: NOW }), /Add an address to each school/);
});

test("manual refresh is limited to once a day; the weekly job isn't", async () => {
  const recent = [{ from_id: "base", to_id: "maple", minutes: 9, source: "google", updated_at: "2026-11-20T10:00:00Z" }];
  fakeServices({ schools: [{ id: "maple", name: "Maple", address: "2 Oak Ave" }], times: recent });
  const st = await travelStatus(env, NOW);
  assert.equal(st.canRefresh, false);
  assert.match(st.reason, /last 24 hours/);
  await assert.rejects(refreshTravelTimes(env, { now: NOW }), /last 24 hours/);
  const r = await refreshTravelTimes(env, { now: NOW, force: true });
  assert.equal(r.updated, 2);
});

test("Google's real invalid-key reply (error wrapped in a list) is explained", async () => {
  // Captured from routes.googleapis.com with a fake key.
  globalThis.fetch = async () => json([{
    error: {
      code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
    },
  }], 400);
  await assert.rejects(
    fetchDrivingMatrix({ GOOGLE_MAPS_API_KEY: "bad" }, places, new Date()),
    /API key isn't valid\. Check the GOOGLE_MAPS_API_KEY secret\. Google said: "API key not valid/,
  );
});
