# School Pickups

Daily pickup schedules for an afterschool program. Every weekday at 12:00 PM
(Los Angeles time) each driver's route for the afternoon is ready on their own
web page link. Runs on Cloudflare Workers. Supabase (database) and the Nvidia
LLM API plug in later.

## How it works

| Step | What happens | Code |
|---|---|---|
| 1 | Daily changes (absences, driver off, early release) are recorded | `exceptions` in `src/sample-data.js` (Supabase later) |
| 2 | Today's roster: who needs pickup, which drivers work, dismissal times | `buildRoster` in `src/scheduler.js` |
| 3 | Driving times between the center and each school | `travelMinutes` in `src/sample-data.js` |
| 4 | Assign students to drivers, order stops; a full car returns to the center and goes again | `assignRoutes` in `src/scheduler.js` |
| 5 | Write each route as a readable message (Nvidia LLM if a key is set) | `src/llm.js` |
| 6–7 | 12 PM weekday job builds the schedule; drivers open their link | `scheduled` in `src/index.js`, `public/index.html` |

All drivers start and end at the center. The LLM only rewrites the text; it
never decides assignments, and its output is discarded if a student name goes
missing.

## AI features (Nvidia)

Needs the `NVIDIA_API_KEY` secret on the Worker (Settings → Variables and Secrets,
type **Secret**). Check it's picked up at `/api/health` (`"llm": true`).

- **Daily changes:** staff paste a message ("Leo absent Thursday, Driver B off
  today"). The AI proposes changes; each is checked against the real student,
  driver and school lists, and nothing is applied until staff confirm.
- **Text message:** each driver card can produce a friendly message to copy and
  send. If the AI drops any name or time, the plain version is used instead.
- AI requests are limited to 10 per minute per visitor (`LLM_LIMITER`).
- Until Supabase is connected, applied changes are saved in the staff member's
  browser only; driver links don't see them yet.
- Student names are sent to Nvidia to read messages. Review this before using
  real student data.

## Links

- Everyone's routes: `https://<your-worker>.workers.dev/`
- One driver: `https://<your-worker>.workers.dev/?driver=d1`
- A specific day: add `&date=2026-11-16`
- Raw data: `/api/schedule?date=2026-11-16` (add `&format=text` for driver messages)

## Deploying

Cloudflare Workers Builds is connected to this GitHub repository. Every push
to `main` deploys automatically; other branches get a preview URL. Build
command: none. Deploy command: `npx wrangler deploy`. GitHub Actions only runs
the tests.

## Running locally

```bash
npm install
npm test
npm run dev        # http://localhost:8787
```

Trigger the 12 PM job by hand: `curl "http://localhost:8787/__scheduled?cron=0+20+*+*+1-5"`.
It only acts when it is actually 12 PM in `TIMEZONE`.

## Managing drivers and students

`/manage.html` (linked from the staff schedule page) has a **Drivers** tab and
a **Students** tab to add, edit, deactivate and reactivate records. Changes
save to Supabase and appear on the schedule right away. Deactivating keeps the
record (and its history) but leaves it out of future schedules.

It needs a staff login: add a **`STAFF_PASSWORD`** secret in Cloudflare
(Worker → Settings → Variables and Secrets). Until it is set, editing is off.
Logins last 12 hours; changing the password logs everyone out. Run
`supabase/schema.sql` again once to add the `drivers.active` column.

## When a driver can't work

On their link (`/?driver=<id>`), a driver clicks **I can't work this day**.
The page shows the effect first (who takes their students, and whether
everyone is still covered), then saves a `driver_off` change to Supabase on
confirm. Everyone's schedule rebuilds with the remaining drivers, including
second trips if cars are full; students who can't be covered are listed under
"Needs attention". **I can work after all** undoes it. Requires the database.

In Claude Code, the project skill `.claude/skills/driver-unavailable/` covers
the same situation; preview from the command line with
`node .claude/skills/driver-unavailable/scripts/reschedule.mjs --driver "Driver B" --date tomorrow`.

## Supabase (database)

1. In the Supabase SQL Editor, run `supabase/schema.sql` (creates the tables),
   then optionally `supabase/seed.sql` (loads the made-up sample data) and
   `supabase/schools-west-covina.sql` (10 real West Covina public schools with
   addresses; dismissal times must be filled in from each school's bell
   schedule). All are safe to run more than once.
2. In Cloudflare: Worker → Settings → Variables and Secrets, add as **Secret**:
   - `SUPABASE_URL`: e.g. `https://<project>.supabase.co`
   - `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → **Secret key** (`sb_secret_…`)
3. Check `/api/health` shows `"database": "connected"`.

The publishable key (`SUPABASE_PUBLISHABLE_KEY`) isn't used: row-level security
is on for every table with no public policies, so it can't read student data.
The secret key stays on Cloudflare's servers and never reaches the browser.

Until the secret key is set, the site uses `src/sample-data.js` and says so.
Daily changes stored in the `exceptions` table (with `confirmed = true`) are
applied for everyone, including driver links. Changes applied on the page are
still saved in that browser only.

## Driving times (Google Routes API, with traffic)

The scheduler uses the `travel_times` table. With Google set up, the Worker
asks the Routes API for driving times **at 3 PM on the next weekday** (traffic
predictions) between the center and every school, in both directions, and
saves them there. It runs every Monday at about 2–3 AM Los Angeles time, and
staff can press **Refresh driving times** (up to 10 successful refreshes per
day, Los Angeles time; failed attempts don't count; change with
`TRAVEL_REFRESHES_PER_DAY` in `wrangler.jsonc`). Only
addresses are sent to Google, never student information.

Setup:
1. In Google Cloud: create a project with billing, enable the **Routes API**,
   and create an API key restricted to the Routes API.
2. In Cloudflare (Worker → Settings → Variables and Secrets):
   - `GOOGLE_MAPS_API_KEY` as a **Secret**
   - `CENTER_ADDRESS` (the afterschool center's street address) as a Variable
3. Run `supabase/schema.sql` again (adds two columns; safe to re-run).
4. Put each school's street address in the Supabase `schools` table.
5. Press **Refresh driving times** on the staff page.

Change the traffic time with `TRAFFIC_DEPARTURE` in `wrangler.jsonc`.

## Secrets

Set on the Worker (Cloudflare dashboard, type Secret, or `npx wrangler secret put NAME`):
`NVIDIA_API_KEY`, `SUPABASE_SECRET_KEY`, `GOOGLE_MAPS_API_KEY`, `STAFF_PASSWORD`. Never commit them.

## Before using real student data

The site currently has **no login** and shows sample (made-up) names only.
Before loading real students, add access control (for example Cloudflare
Access for staff, and an unguessable token per driver link instead of `d1`).
