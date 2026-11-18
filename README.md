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

## Links

- Everyone's routes: `https://<your-worker>.workers.dev/`
- One driver: `https://<your-worker>.workers.dev/?driver=d1`
- A specific day: add `&date=2026-11-16`
- Raw data: `/api/schedule?date=2026-11-16` (add `&format=text` for driver messages)

## Deploying from GitHub

1. In this repository on GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - `CLOUDFLARE_API_TOKEN`: the token you created
   - `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard (Workers & Pages overview)
2. Merge into `main`, or run **Actions → Deploy to Cloudflare → Run workflow**.
3. The site appears at `https://schoolpickups.<your-subdomain>.workers.dev`.

## Running locally

```bash
npm install
npm test
npm run dev        # http://localhost:8787
```

Trigger the 12 PM job by hand: `curl "http://localhost:8787/__scheduled?cron=0+20+*+*+1-5"`.
It only acts when it is actually 12 PM in `TIMEZONE`.

## Later: secrets

Set these on the Worker (never commit them):

```bash
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
```

The database tables are in `supabase/schema.sql`.

## Before using real student data

The site currently has **no login** and shows sample (made-up) names only.
Before loading real students, add access control (for example Cloudflare
Access for staff, and an unguessable token per driver link instead of `d1`).
