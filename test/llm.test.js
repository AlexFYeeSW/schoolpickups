import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as sample from "../src/sample-data.js";
import { validateChanges, extractJson, parseChanges } from "../src/changes.js";
import { driverMessage, chat, cleanKey, resetModelCache, rankModels, skippedModels } from "../src/llm.js";
import { buildDailySchedule } from "../src/scheduler.js";

const env = { NVIDIA_API_KEY: "test-key", NVIDIA_MODEL: "meta/llama-3.3-70b-instruct" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetModelCache(); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * Fake Nvidia API. `models` = ids returned by GET /models; `reply` = chat text
 * (or a function (model) => Response for custom behaviour).
 */
function fakeNvidia({ models = ["meta/llama-3.3-70b-instruct"], reply = "OK", modelsStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url.endsWith("/models")) return json({ data: models.map((id) => ({ id })) }, modelsStatus);
    if (typeof reply === "function") return reply(call.body.model);
    return json({ choices: [{ message: { content: reply } }] });
  };
  return calls;
}
const fakeReply = (content, status = 200) =>
  fakeNvidia({ reply: () => (status === 200 ? json({ choices: [{ message: { content } }] }) : json({ detail: "boom" }, status)) });

test("validateChanges keeps good changes and rejects bad ones", () => {
  const { valid, rejected } = validateChanges(sample, [
    { type: "student_absent", date: "2026-11-19", studentId: "s10" },
    { type: "driver_off", date: "2026-11-18", driverId: "d2" },
    { type: "dismissal_change", date: "2026-11-19", schoolId: "maple", dismissal: "13:30" },
    { type: "student_absent", date: "2026-11-19", studentId: "nobody" },
    { type: "dismissal_change", date: "2026-11-19", schoolId: "maple", dismissal: "3:00" },
    { type: "cancel_everything", date: "2026-11-19" },
    { type: "driver_off", date: "tomorrow", driverId: "d1" },
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[2].dismissal, 810);
  assert.match(valid[0].summary, /Leo .* absent \(Thu 11-19\)/);
  assert.equal(rejected.length, 4);
});

test("extractJson handles code fences and extra words", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"changes":[],"unclear":["x"]}\n```'), { changes: [], unclear: ["x"] });
  assert.throws(() => extractJson("no json here"));
});

test("parseChanges sends the roster and returns checked changes", async () => {
  const calls = fakeReply(JSON.stringify({
    changes: [
      { type: "student_absent", date: "2026-11-19", studentId: "s10" },
      { type: "student_absent", date: "2026-11-19", studentId: "s99" },
    ],
    unclear: ["Two students are named Max"],
  }));
  const r = await parseChanges("Leo absent Thursday", sample, "2026-11-18", env);
  const chatCall = calls.find((c) => c.body);
  assert.equal(chatCall.auth, "Bearer test-key");
  assert.equal(chatCall.body.model, "meta/llama-3.3-70b-instruct");
  assert.match(chatCall.body.messages[0].content, /Today is wed 2026-11-18/);
  assert.match(chatCall.body.messages[0].content, /s10 \| Leo/);
  assert.equal(r.changes.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.unclear, ["Two students are named Max"]);
});

test("parseChanges copes with an unreadable reply", async () => {
  fakeReply("I'm not sure what you mean.");
  const r = await parseChanges("hello", sample, "2026-11-18", env);
  assert.equal(r.changes.length, 0);
  assert.equal(r.unclear.length, 1);
});

test("applied changes affect the schedule", () => {
  const { valid } = validateChanges(sample, [{ type: "driver_off", date: "2026-11-16", driverId: "d2" }]);
  const s = buildDailySchedule({ ...sample, exceptions: valid }, "2026-11-16");
  assert.ok(!s.routes.some((r) => r.driverId === "d2"));
});

test("driverMessage uses AI text only if nothing went missing", async () => {
  const route = buildDailySchedule(sample, "2026-11-16").routes[0];
  const allNames = route.stops.flatMap((s) => [s.time, ...s.students.map((k) => k.name)]).join(" ");

  fakeReply(`Hi! Here's today: ${allNames}`);
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "nvidia");

  fakeReply("Hi! Short version with names left out.");
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "plain");

  fakeReply("error", 500);
  assert.equal((await driverMessage(route, "2026-11-16", env)).source, "plain");

  assert.equal((await driverMessage(route, "2026-11-16", {})).source, "plain");
});

test("cleanKey fixes copy-paste mistakes", () => {
  assert.equal(cleanKey('  "nvapi-abc"\n'), "nvapi-abc");
  assert.equal(cleanKey("Bearer nvapi-abc"), "nvapi-abc");
  assert.equal(cleanKey(undefined), "");
});

test("picks a model Nvidia actually offers", async () => {
  const calls = fakeNvidia({ models: ["some/embedding-model", "meta/llama-3.1-8b-instruct"] });
  const { model } = await chat(env, "s", "u");
  assert.equal(model, "meta/llama-3.1-8b-instruct");
  assert.equal(calls.find((c) => c.body).body.model, "meta/llama-3.1-8b-instruct");
});

test("if a model is not found, tries the next one", async () => {
  fakeNvidia({
    modelsStatus: 500, // model list unavailable: fall back to trying names directly
    reply: (model) => model === "meta/llama-3.3-70b-instruct"
      ? json({ detail: "Function not found for account" }, 404)
      : json({ choices: [{ message: { content: "OK" } }] }),
  });
  const { model, text } = await chat(env, "s", "u");
  assert.equal(text, "OK");
  assert.notEqual(model, "meta/llama-3.3-70b-instruct");
});

test("a rejected key gives a clear message", async () => {
  fakeNvidia({ modelsStatus: 401, reply: () => json({ detail: "Authentication failed" }, 401) });
  await assert.rejects(chat(env, "s", "u"), /rejected the API key \(401\)/);
});

test("network failure gives a clear message", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(chat(env, "s", "u"), /Couldn't reach Nvidia/);
});

test("never picks translation, speech or embedding models", () => {
  const ids = [
    "nvidia/riva-translate-4b-instruct-v2",
    "nvidia/nv-embedqa-e5-v5",
    "nvidia/llama-3.1-nemoguard-8b-content-safety",
    "qwen/qwen2.5-coder-32b-instruct",
    "openai/gpt-oss-20b",
    "mistralai/mistral-small-24b-instruct",
  ];
  const ranked = rankModels({}, ids);
  assert.deepEqual(ranked, ["openai/gpt-oss-20b", "mistralai/mistral-small-24b-instruct"]);
});

test("models refused for this account (403/404) are skipped until one works", async () => {
  fakeNvidia({
    models: ["meta/llama-3.3-70b-instruct", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "nvidia/riva-translate-4b-instruct-v2"],
    reply: (model) =>
      model === "meta/llama-3.3-70b-instruct" ? json({ detail: "Function not found for account" }, 404)
      : model === "openai/gpt-oss-120b" ? json({ detail: "Authorization failed" }, 403)
      : json({ choices: [{ message: { content: '<think>adding</think>{"answer": 5}' } }] }),
  });
  const { model, text } = await chat(env, "s", "u");
  assert.equal(model, "openai/gpt-oss-20b");
  assert.equal(text, '{"answer": 5}');
  assert.deepEqual(Object.keys(skippedModels()), ["meta/llama-3.3-70b-instruct", "openai/gpt-oss-120b"]);
});

test("when every model is refused, the error lists what was tried", async () => {
  fakeNvidia({ models: ["meta/llama-3.3-70b-instruct"], reply: () => json({ detail: "Function not found for account" }, 404) });
  await assert.rejects(chat(env, "s", "u"), /None of the AI models.*llama-3\.3-70b-instruct: 404 Function not found/);
});
