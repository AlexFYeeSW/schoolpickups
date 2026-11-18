// Calls to the Nvidia LLM API (OpenAI-compatible). The key lives in the
// NVIDIA_API_KEY Worker secret. Every feature has a non-LLM fallback.

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const TIMEOUT_MS = 30_000;

// Tried in order after NVIDIA_MODEL; the first one Nvidia actually offers is used.
const PREFERRED_MODELS = [
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "meta/llama-3.1-8b-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
];

/** An error with a message that is safe and useful to show staff. */
export class LlmError extends Error {
  constructor(userMessage, status) {
    super(userMessage);
    this.status = status;
  }
}

export function llmEnabled(env) {
  return Boolean(cleanKey(env.NVIDIA_API_KEY));
}

/** Tolerate common copy-paste mistakes: spaces, quotes, a "Bearer " prefix. */
export function cleanKey(key) {
  return String(key ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function friendly(status, detail) {
  const d = detail ? ` Nvidia said: "${detail}"` : "";
  if (status === 401 || status === 403)
    return `Nvidia rejected the API key (${status}). Check the NVIDIA_API_KEY secret; it should start with "nvapi-".${d}`;
  if (status === 404) return `The AI model wasn't found on Nvidia (404).${d}`;
  if (status === 429) return "Nvidia's usage limit was reached (429). Wait a minute and try again.";
  if (status >= 500) return `Nvidia's service had a problem (${status}). Try again shortly.${d}`;
  return `Nvidia returned an error (${status}).${d}`;
}

async function request(env, path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cleanKey(env.NVIDIA_API_KEY)}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError")
      throw new LlmError(`Nvidia took longer than ${TIMEOUT_MS / 1000} seconds to answer. Try again.`, 504);
    throw new LlmError(`Couldn't reach Nvidia (${err?.message || "network error"}).`, 502);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      const j = JSON.parse(raw);
      detail = j.detail || j.error?.message || j.error || j.message || j.title || raw;
    } catch {}
    detail = String(detail).replace(/\s+/g, " ").slice(0, 160);
    console.error(`Nvidia ${init.method || "GET"} ${path} -> ${res.status}: ${detail}`);
    throw new LlmError(friendly(res.status, detail), res.status);
  }
  return res.json();
}

// Cache the chosen model for an hour per Worker instance.
let modelCache = { model: null, at: 0 };
const badModels = new Set();

export function resetModelCache() {
  modelCache = { model: null, at: 0 };
  badModels.clear();
}

/** Pick a model Nvidia actually offers: NVIDIA_MODEL first, then the preferred list. */
export async function resolveModel(env) {
  if (modelCache.model && Date.now() - modelCache.at < 3_600_000) return modelCache.model;

  const wanted = [env.NVIDIA_MODEL, ...PREFERRED_MODELS].filter((m) => m && !badModels.has(m));
  let available = null;
  try {
    const list = await request(env, "/models");
    available = new Set((list.data || []).map((m) => m.id));
  } catch (err) {
    // A bad key should be reported as such; anything else, just try our first choice.
    if (err.status === 401 || err.status === 403) throw err;
  }

  let model = wanted[0];
  if (available?.size) {
    model =
      wanted.find((m) => available.has(m)) ||
      [...available].find((id) => /instruct/i.test(id) && !/embed|rerank|guard|reward|vision|vlm|coder|parse/i.test(id));
    if (!model) throw new LlmError("Nvidia didn't list any suitable chat model for this API key.", 404);
  }
  modelCache = { model, at: Date.now() };
  return model;
}

/** Send a system + user message, return { text, model }. Throws LlmError. */
export async function chat(env, system, user, { maxTokens = 800, temperature = 0.2 } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = await resolveModel(env);
    try {
      const json = await request(env, "/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new LlmError("Nvidia sent back an empty answer. Try again.", 502);
      return { text, model };
    } catch (err) {
      // Model missing or not allowed for this key: skip it and try the next one.
      const modelProblem = err.status === 404 || (err.status === 400 && /model/i.test(err.message));
      if (!modelProblem) throw err;
      badModels.add(model);
      modelCache = { model: null, at: 0 };
    }
  }
  throw new LlmError("None of the AI models could be used with this API key.", 404);
}

// ---------- Step 5: driver messages ----------

export function plainText(route, date) {
  const lines = [`Pickup schedule for ${route.driverName} — ${date}`];
  route.stops.forEach((stop, i) => {
    const verb = stop.type === "pickup" ? "Pick up at" : "Drop off at";
    const extra = stop.dismissal ? ` (dismissal ${stop.dismissal})` : "";
    lines.push(`${i + 1}. ${stop.time} — ${verb} ${stop.place}${extra}`);
    if (stop.type === "pickup") {
      for (const s of stop.students) lines.push(`   • ${s.name}${s.notes ? ` (${s.notes})` : ""}`);
    } else {
      lines.push(`   ${stop.students.length} students`);
    }
  });
  return lines.join("\n");
}

/** Returns { text, source, note? } where source is "nvidia" or "plain". */
export async function driverMessage(route, date, env) {
  const fallback = plainText(route, date);
  if (!llmEnabled(env)) return { text: fallback, source: "plain" };

  try {
    const { text } = await chat(
      env,
      "You rewrite a school pickup route into a short, friendly text message for the driver. " +
        "Keep every stop, time and student name exactly as given, in the same order. Do not add, " +
        "remove or reorder anything. Mention special notes clearly. Plain text, no markdown.",
      fallback,
    );
    // Safety check: if any student name or time went missing, use the plain version.
    const must = route.stops.flatMap((s) => [s.time, ...(s.type === "pickup" ? s.students.map((x) => x.name) : [])]);
    if (!must.every((m) => text.includes(m))) {
      return { text: fallback, source: "plain", note: "The AI version left something out, so the plain version is shown." };
    }
    return { text, source: "nvidia" };
  } catch (err) {
    console.error("LLM message failed, using plain text:", err.message);
    return { text: fallback, source: "plain", note: err.message };
  }
}
