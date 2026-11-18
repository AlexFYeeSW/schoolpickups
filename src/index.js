import * as sample from "./sample-data.js";
import { buildDailySchedule } from "./scheduler.js";
import { driverMessage } from "./llm.js";

// Until Supabase is connected, data comes from sample-data.js.
async function loadData(_env) {
  return sample;
}

/** Today's date (YYYY-MM-DD) and hour in the business's time zone. */
function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/schedule") {
      const date = url.searchParams.get("date") || localNow(env.TIMEZONE).date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
      const schedule = buildDailySchedule(await loadData(env), date);

      if (url.searchParams.get("format") === "text") {
        const messages = await Promise.all(schedule.routes.map((r) => driverMessage(r, date, env)));
        return new Response(messages.join("\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return json(schedule);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },

  // Step 6–7: runs from the cron trigger in wrangler.jsonc.
  async scheduled(controller, env, ctx) {
    const { date, hour } = localNow(env.TIMEZONE, new Date(controller.scheduledTime));
    // Two UTC crons cover daylight saving; only the one at 12 PM local time acts.
    if (hour !== Number(env.SEND_HOUR)) {
      console.log(`Skipping: it is ${hour}:00 in ${env.TIMEZONE}, not ${env.SEND_HOUR}:00.`);
      return;
    }

    const schedule = buildDailySchedule(await loadData(env), date);
    for (const w of schedule.warnings) console.warn("Schedule warning:", w);

    // TODO: save the schedule to Supabase and send each message by SMS/email.
    for (const route of schedule.routes) {
      const message = await driverMessage(route, date, env);
      console.log(`Would send to ${route.driverName}:\n${message}`);
    }
  },
};

export { localNow };
