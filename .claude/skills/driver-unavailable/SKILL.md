---
name: driver-unavailable
description: Reschedule student pickups when a driver can't work on a given day, so the remaining drivers still pick up every student. Use when a driver reports (on the website, by message, or through staff) that they are not working on a particular day, when asked who covers an absent driver's students, or when changing how the website handles driver unavailability.
---

# Driver unavailable

When a driver can't work on a day, their students must go to the remaining
drivers so that **every student is still picked up**. The scheduler does the
reassignment (plain code, never the LLM); this skill makes sure it is checked,
explained, and recorded correctly.

## How it works in the app

- A driver opens their link (`/schedule?driver=<id>`) and clicks **I can't work this
  day**. The page first calls `POST /api/driver-unavailable` with
  `preview: true` to show the effect, then again without it to save.
- Staff can also do it from the Manage page (`/manage.html` → Drivers →
  Days off, staff login required): `POST /api/admin/days-off` (with
  `preview`), `GET /api/admin/days-off` (upcoming), and
  `POST /api/admin/days-off/undo`.
- Saving inserts a confirmed `driver_off` row in the Supabase `exceptions`
  table (`markDriverOff` in `src/db.js`). Every page and driver link then
  shows the rebuilt schedule. **I can work after all** calls
  `POST /api/driver-available` to undo it.
- The rebuild is `rescheduleWithoutDriver` in `src/reschedule.js`, which runs
  the normal scheduler (`src/scheduler.js`) without that driver and reports
  `moved` (who took each student), `unassigned` (students nobody can reach)
  and `allCovered`. Full cars return to the center and make second trips.
- Without the Supabase secret key the site uses sample data and refuses to
  save (other people wouldn't see it).

## Steps when a driver reports they can't work

1. **Identify the driver and the date.** Accept a driver id (`d2`) or name.
   Resolve "today", "tomorrow" or a weekday name in America/Los_Angeles.
   Pickups are Monday to Friday only. If the driver or date is ambiguous,
   ask the user; never guess.

2. **Preview the reschedule** (read-only):

   ```bash
   node .claude/skills/driver-unavailable/scripts/reschedule.mjs --driver "<id or name>" --date <date>
   ```

   It uses live Supabase data when `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
   are set in the environment, otherwise the sample data (it says which).
   Add `--json` for machine-readable output.

3. **Report to the user**, in plain words:
   - whether all students are still covered;
   - which students moved to which driver, with new pickup times;
   - any students **not covered** and any warnings (long waits after
     dismissal);
   - whether the change is already recorded.

4. **If students are not covered**, don't hide it. Offer options: a backup
   driver (add or reactivate one in the `drivers` table for that day), asking
   another driver to make an extra trip, or contacting those families. Re-run
   step 2 after any change to confirm coverage.

5. **Record it only with the user's confirmation.** If the driver used the
   website, it is already saved. Otherwise, either:
   - give the user the SQL the script prints, to run in the Supabase SQL
     Editor; or
   - tell them to have the driver click the button on their link; or
   - tell them to use Manage → Drivers → Days off (staff login).

   Never write to the database yourself without explicit confirmation, and
   never put database keys in code or chat.

## Changing the behaviour (for code changes)

- Assignment rules: `assignRoutes` in `src/scheduler.js`. It tries many plans
  and keeps the one with the fewest children waiting over
  `TARGET_WAIT_MINUTES` (30) after dismissal, then the shortest longest wait,
  then the least driving. Waits over the target appear as warnings.
- Endpoints: `/api/driver-unavailable`, `/api/driver-available` and the staff
  `/api/admin/days-off` routes in `src/index.js` (shared logic in
  `markUnavailable` / `markAvailable`). Pages: `renderDriverPanel` in
  `public/index.html`; the Days off panel in `public/manage.html`.
- Tests: `test/reschedule.test.js`. Run `npm test` before pushing; every push
  to `main` deploys the site.
