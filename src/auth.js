// Staff login for the Manage pages: one shared password (STAFF_PASSWORD
// Worker secret). Logging in sets an HttpOnly cookie signed with HMAC-SHA256;
// changing the password logs everyone out. If STAFF_PASSWORD isn't set,
// editing is switched off entirely.

const COOKIE = "staff_session";
const SESSION_HOURS = 12;
const enc = new TextEncoder();

export function staffLoginEnabled(env) {
  return String(env.STAFF_PASSWORD || "").length > 0;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two strings without leaking how much of them matched. */
async function safeEqual(a, b) {
  // Hash both to the same length first, then compare every byte.
  const [x, y] = await Promise.all([hmac("compare", String(a)), hmac("compare", String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(env, password) {
  if (!staffLoginEnabled(env) || typeof password !== "string") return false;
  return safeEqual(password, env.STAFF_PASSWORD);
}

/** Set-Cookie header value for a new session. */
export async function sessionCookie(env, now = Date.now()) {
  const expires = now + SESSION_HOURS * 3_600_000;
  const value = `${expires}.${await hmac(env.STAFF_PASSWORD, `staff:${expires}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** True if the request carries a valid, unexpired staff session. */
export async function isStaff(request, env, now = Date.now()) {
  if (!staffLoginEnabled(env)) return false;
  const cookies = request.headers.get("Cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`).exec(cookies);
  if (!m) return false;
  const expires = Number(m[1]);
  if (!(expires > now)) return false;
  return safeEqual(m[2], await hmac(env.STAFF_PASSWORD, `staff:${expires}`));
}
