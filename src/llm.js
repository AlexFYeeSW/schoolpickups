// Calls to the Nvidia LLM API (OpenAI-compatible). The key lives in the
// NVIDIA_API_KEY Worker secret. Every feature has a non-LLM fallback.

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export function llmEnabled(env) {
  return Boolean(env.NVIDIA_API_KEY);
}

/** Send a system + user message, return the model's text. Throws on failure. */
export async function chat(env, system, user, { maxTokens = 800, temperature = 0.2 } = {}) {
  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.NVIDIA_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Nvidia API ${res.status}: ${detail}`);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Nvidia API returned no text");
  return text;
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

/** Returns { text, source } where source is "nvidia" or "plain". */
export async function driverMessage(route, date, env) {
  const fallback = plainText(route, date);
  if (!llmEnabled(env)) return { text: fallback, source: "plain" };

  try {
    const text = await chat(
      env,
      "You rewrite a school pickup route into a short, friendly text message for the driver. " +
        "Keep every stop, time and student name exactly as given, in the same order. Do not add, " +
        "remove or reorder anything. Mention special notes clearly. Plain text, no markdown.",
      fallback,
    );
    // Safety check: if any student name or time went missing, use the plain version.
    const must = route.stops.flatMap((s) => [s.time, ...(s.type === "pickup" ? s.students.map((x) => x.name) : [])]);
    if (!must.every((m) => text.includes(m))) return { text: fallback, source: "plain" };
    return { text, source: "nvidia" };
  } catch (err) {
    console.error("LLM message failed, using plain text:", err.message);
    return { text: fallback, source: "plain" };
  }
}
