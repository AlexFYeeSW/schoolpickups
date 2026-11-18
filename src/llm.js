// Step 5: turn a driver's structured route into a short, readable message.
// Uses the Nvidia API (OpenAI-compatible) when NVIDIA_API_KEY is set; otherwise
// falls back to a plain template so the app works without a key.

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

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

export async function driverMessage(route, date, env) {
  const fallback = plainText(route, date);
  if (!env.NVIDIA_API_KEY) return fallback;

  try {
    const res = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.NVIDIA_MODEL,
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content:
              "You rewrite a school pickup route into a short, friendly text message for the driver. " +
              "Keep every stop, time and student name exactly as given, in the same order. Do not add, " +
              "remove or reorder anything. Mention special notes clearly. Plain text, no markdown.",
          },
          { role: "user", content: fallback },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Nvidia API ${res.status}`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    // Safety check: if any student name went missing, use the plain version.
    const names = route.stops.flatMap((s) => (s.type === "pickup" ? s.students.map((x) => x.name) : []));
    if (!text || !names.every((n) => text.includes(n))) return fallback;
    return text;
  } catch (err) {
    console.error("LLM formatting failed, using plain text:", err.message);
    return fallback;
  }
}
