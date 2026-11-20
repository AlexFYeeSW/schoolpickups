import { buildDailySchedule } from "./scheduler.js";
import { loadData as loadFromDb, dbStatus, DbError } from "./db.js";
import { driverMessage, llmEnabled, chat, LlmError, skippedModels } from "./llm.js";
import { parseChanges, validateChanges, MAX_TEXT_LENGTH } from "./changes.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Supabase when SUPABASE_URL + SUPABASE_SECRET_KEY are set; sample data otherwise.
async function loadData(env) {
  return loadFromDb(env, localNow(env.TIMEZONE).date);
}

/** Master data plus the day's changes sent from the page (checked first). */
async function dataWithChanges(env, changes) {
  const data = await loadData(env);
  const { valid } = validateChanges(data, changes);
  return { ...data, exceptions: [...data.exceptions, ...valid] };
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

async function readBody(request) {
  try {
    const text = await request.text();
    if (text.length > 50_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Limit AI calls per visitor so the public site can't run up the Nvidia bill. */
async function allowLlmCall(request, env) {
  if (!env.LLM_LIMITER) return true;
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.LLM_LIMITER.limit({ key });
  return success;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof DbError) return json({ error: err.message, database: dbStatus(env) }, 503);
      console.error("Unhandled error:", err?.stack || err);
      return json({ error: `Server error: ${err?.message || err}` }, 500);
    }
  },

  // Step 6–7: runs from the cron trigger in wrangler.jsonc.
  async scheduled(controller, env) {
    return runNoonJob(controller, env);
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return json({ ok: true, llm: llmEnabled(env), database: dbStatus(env) });
  }

  // GET ?date=… for the plain schedule; POST {date, changes} to include today's changes.
  if (path === "/api/schedule") {
    let date = url.searchParams.get("date");
    let changes = [];
    if (request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ error: "Invalid JSON body" }, 400);
      date = body.date;
      changes = body.changes ?? [];
    }
    date ||= localNow(env.TIMEZONE).date;
    if (!DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    const data = await dataWithChanges(env, changes);
    let schedule;
    try {
      schedule = buildDailySchedule(data, date);
    } catch (err) {
      return json({ error: err.message, dataSource: data.source }, 422);
    }

    if (url.searchParams.get("format") === "text") {
      if (llmEnabled(env) && !(await allowLlmCall(request, env))) {
        return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      }
      const msgs = await Promise.all(schedule.routes.map((r) => driverMessage(r, date, env)));
      return new Response(msgs.map((m) => m.text).join("\n\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return json({ ...schedule, dataSource: data.source, database: data.dbStatus });
  }

  // POST {text} → AI reads a message and proposes changes for staff to confirm.
  if (path === "/api/changes/parse" && request.method === "POST") {
    if (!llmEnabled(env)) return json({ error: "The Nvidia API key isn't set up yet." }, 503);
    const body = await readBody(request);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "Type or paste a message first." }, 400);
    if (text.length > MAX_TEXT_LENGTH) return json({ error: `Keep messages under ${MAX_TEXT_LENGTH} characters.` }, 400);
    if (!(await allowLlmCall(request, env))) return json({ error: "Too many requests. Wait a minute and try again." }, 429);

    try {
      const today = DATE_RE.test(body.today ?? "") ? body.today : localNow(env.TIMEZONE).date;
      return json(await parseChanges(text, await loadData(env), today, env));
    } catch (err) {
      console.error("Parse failed:", err.message);
      if (err instanceof LlmError) {
        const status = err.status === 429 || err.status === 504 ? err.status : 502;
        return json({ error: err.message, nvidiaStatus: err.status ?? null }, status);
      }
      return json({ error: "Something went wrong reading the message." }, 500);
    }
  }

  // GET → one tiny test call to Nvidia; shows whether the key and model work.
  if (path === "/api/ai-check") {
    if (!llmEnabled(env)) return json({ ok: false, error: "NVIDIA_API_KEY secret is not set on this Worker." });
    if (!(await allowLlmCall(request, env))) return json({ ok: false, error: "Too many requests. Wait a minute." }, 429);
    const started = Date.now();
    try {
      const { text, model } = await chat(
        env,
        'You are a test. Answer with a JSON object only: {"answer": <number>}',
        "What is 2 + 3?",
        { maxTokens: 400, temperature: 0 },
      );
      const followsInstructions = /"answer"\s*:\s*5\b/.test(text);
      return json({ ok: true, model, followsInstructions, reply: text.slice(0, 200), ms: Date.now() - started, skipped: skippedModels() });
    } catch (err) {
      return json({ ok: false, error: err.message, status: err.status ?? null, ms: Date.now() - started, skipped: skippedModels() });
    }
  }

  // POST {date, driverId, changes} → friendly text message for one driver.
  if (path === "/api/driver-message" && request.method === "POST") {
    const body = await readBody(request);
    if (!body || !DATE_RE.test(body.date ?? "")) return json({ error: "date must be YYYY-MM-DD" }, 400);
    const schedule = buildDailySchedule(await dataWithChanges(env, body.changes ?? []), body.date);
    const route = schedule.routes.find((r) => r.driverId === body.driverId);
    if (!route) return json({ error: "That driver has no route on this day." }, 404);
    if (llmEnabled(env) && !(await allowLlmCall(request, env))) {
      return json({ error: "Too many requests. Wait a minute and try again." }, 429);
    }
    return json(await driverMessage(route, body.date, env));
  }

  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(request);
}

async function runNoonJob(controller, env) {
  const { date, hour } = localNow(env.TIMEZONE, new Date(controller.scheduledTime));
  // Two UTC crons cover daylight saving; only the one at 12 PM local time acts.
  if (hour !== Number(env.SEND_HOUR)) {
    console.log(`Skipping: it is ${hour}:00 in ${env.TIMEZONE}, not ${env.SEND_HOUR}:00.`);
    return;
  }

  const schedule = buildDailySchedule(await loadData(env), date);
  for (const w of schedule.warnings) console.warn("Schedule warning:", w);

  // TODO: save the locked schedule to the Supabase `schedules` table.
  for (const route of schedule.routes) {
    const { text } = await driverMessage(route, date, env);
    console.log(`Schedule ready for ${route.driverName}:\n${text}`);
  }
}

export { localNow };
