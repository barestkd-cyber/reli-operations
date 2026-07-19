# RELI Ops — CRM

Internal operations CRM for RELI Commercial Cleaning. Ported from the 4K Cleaning ops app and rebranded to RELI colors.

**This is a private internal tool. It is deliberately NOT part of `reli-site/` and is not published to the public GitHub Pages preview.**

## Files
| File | Purpose |
|------|---------|
| `index.html` | The CRM — Contacts, Schedule, Lead Manager, Outreach, Reports, Staff |
| `reli-contract.html` | Contract generator (opened from inside the CRM) |
| `assets/` | RELI logo + favicon |

## Setup required before it works

Open `index.html` and replace both values near the top of the data layer:

```js
const SB_URL='https://YOUR-RELI-PROJECT-REF.supabase.co';
const SB_KEY='YOUR-RELI-SUPABASE-PUBLISHABLE-KEY';
```

⚠️ **Point this at RELI's own Supabase project — never at another client's.** A gold banner shows at the bottom of the app until these are filled in.

### Expected Supabase schema
The app reads/writes these tables (same shape as the 4K project):

`contacts` · `events` · `event_overrides` · `deleted_events` · `leads` · `prospects` · `staff` · `profiles`

Auth uses Supabase Auth (email + password); `profiles` supplies role/name after login.

The public site's contact form (`reli-site/assets/js/main.js`) inserts into the **`leads`** table — so once both point at the same RELI project, website enquiries land in the CRM's Lead Manager.

## What was changed from the 4K original
- **Colors:** teal → RELI gold `#E3BA35`; secondary lavender → neutral slate; amber shifted to `#E8833A` so it doesn't collide with gold; backgrounds moved to RELI's neutral charcoal.
- **Fonts:** DM Sans → **Poppins** (Bebas Neue display kept — RELI already uses it).
- **Branding:** "4K OPS" → "RELI OPS", titles, schedule exports, contract letterhead.
- **Credentials:** 4K's Supabase URL + publishable key **removed**, replaced with placeholders.
- **localStorage** namespaces `4k_v2_*` → `reli_v2_*` so the two apps never share cached data in one browser.
- **Contract letterhead** logo now uses the local RELI logo (was a remote 4K GitHub URL).

## Outreach tab — "Find Businesses"

The Outreach tab can search the web for prospects by service type and add them straight to the call list. The Anthropic call runs **server-side** in a Supabase Edge Function — an API key must never live in `index.html`, which ships to the browser.

**Deploy it:**

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy find-businesses
```

The function lives at `supabase/functions/find-businesses/index.ts`. The browser calls it with the Supabase anon key it already has, so it isn't an open relay. It uses `claude-opus-4-8` with the `web_search_20260209` server-side tool and returns a validated `{ businesses: [...] }` array.

Until both the Supabase credentials **and** this function are deployed, the Find Businesses buttons will report an error — everything else in the CRM works.

## Time Clock (replacing Connecteam)

Cleaners open `timeclock/index.html` on their phone, sign in, pick their job site, and hit one big button. Location is stamped **at clock-in and clock-out** — not during the shift.

| Piece | File |
|---|---|
| Schema, RLS, auto-close rules | `supabase/migrations/0001_timeclock.sql` |
| Punch endpoint (server-side geofence) | `supabase/functions/clock/index.ts` |
| Cleaner-facing page | `timeclock/index.html` |

**Setup:**
```bash
supabase db push
supabase functions deploy clock
```
Then add job sites (name + lat/lng + radius) to `job_sites`, and schedule the auto-close job — in the SQL editor:
```sql
select cron.schedule('close-stale-shifts', '*/15 * * * *',
                     $$select public.close_stale_shifts()$$);
```

### Two design decisions worth knowing

**1. Why there's no mid-shift tracking.** A web page only gets location while it's open and in the foreground — no browser allows background GPS. Only a native app can do what Connecteam does. Mike's actual need was narrower: catching a *forgotten clock-out*, which doesn't require tracking.

**2. How a forgotten clock-out is handled.** `close_stale_shifts()` runs every 15 minutes and applies two conservative rules — neither can inflate hours:

- Shift ran past `max_shift_hours` (default 10) → closed at `clock_in + 10h`
- The person clocked in somewhere else → the old shift is closed at that moment

Anything it touches is flagged and lands in the `timeclock_review` view for Mike to correct before payroll. Manual corrections keep an audit trail (`original_clock_out_at`, `edited_by`, `edited_at`).

**Out-of-range punches are recorded and flagged, never blocked.** Indoor GPS routinely drifts 50–100m+, and a cleaner who physically cannot clock in becomes a phone call at 6am. The default fence is a deliberately generous 200m; tune it in `timeclock_settings`.

Honest limits: browser location can be spoofed, so this is a deterrent and a record rather than proof; and if a site has no signal the punch fails (no offline queue yet). Tell staff their location is recorded at both ends — it's the right thing to do and it heads off the usual pushback.

## Known issues / needs attention
1. **Contract terms are 4K's.** `reli-contract.html` carries an orange banner saying so. The legal wording, scope and pricing were inherited from the 4K template and have **not** been reviewed for RELI. Have RELI review before issuing to any client. (Branding, service types, and per-service task lists have been switched to RELI's six verticals; the surrounding legal articles have not.)
2. Tax rate in the contract generator is hardcoded to `8.25` — confirm it's right for RELI's billing.
3. The Edge Function is written but **untested** — there's no RELI Supabase project or Anthropic key to run it against yet. Expect to shake out one or two things on first deploy.
