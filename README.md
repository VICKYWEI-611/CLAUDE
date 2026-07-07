# Aaniin Community Centre — drop-in swim auto-booker

Automates booking drop-in swim spots at Aaniin Community Centre on the City of
Markham
[PerfectMind / "BookMe4" portal](https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False).

Books these sessions by default:

| Session | Booking opens (21h before) |
|---|---|
| **Sunday 7:45 AM** | Saturday 10:45 AM |
| **Tuesday 8:00–9:00 AM** | Monday 11:00 AM |
| **Friday 8:00–9:00 AM** | Thursday 11:00 AM |

The booking site is a JavaScript app behind a login, so this uses a real
browser (Playwright + Chromium) driven with your own account. Run it on a
schedule so it grabs each spot the moment its booking window opens. Each run
automatically books whichever session's window is open at the time.

---

## Setup

```bash
npm install                 # installs Playwright
npx playwright install chromium   # one-time: downloads the browser
cp .env.example .env        # then edit .env with your login
```

Edit `.env`:

```
PM_EMAIL=you@example.com
PM_PASSWORD=your-password
```

## First run — confirm it works (nothing is booked)

```bash
HEADLESS=0 DRY_RUN=1 node book-swim.mjs
```

- `HEADLESS=0` opens a visible browser so you can watch each step.
- `DRY_RUN=1` does everything **except** the final confirmation click.

Watch it log in, open the calendar, find the next session whose window is
open, and reach the confirmation screen. Screenshots are saved to
`screenshots/` (prefixed by session, e.g. `fri-8-00-am-*`).

> **Important:** the exact button/label text on the authenticated PerfectMind
> pages can vary. The script uses forgiving, text-based selectors, but if a
> step can't find something, open the matching screenshot and adjust the
> relevant selector or the config below. The two most common tweaks are
> `SESSION_KEYWORDS` (to pick the right program if several run at the same time)
> and the times in `SESSIONS` (must match the page text exactly, e.g. `8:00 AM`).

## Book for real

```bash
node book-swim.mjs
```

## Configuration (all optional — see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `PM_EMAIL` / `PM_PASSWORD` | — | **Required.** Your Markham account login. |
| `SESSIONS` | `Sun 7:45 AM; Tue 8:00 AM; Fri 8:00 AM` | Sessions to book, `;`-separated. Each is `Day H:MM AM/PM`; add `\| keywords` to override the title match for that one. |
| `SESSION_KEYWORDS` | `swim` | Default words that must **all** appear in the title (used when a session has no own keywords). |
| `OPEN_HOURS_BEFORE` | `21` | Booking opens this many hours before each session (e.g. Fri 8 AM → Thu 11 AM). |
| `MAX_WAIT_MINUTES` | `30` | If the window isn't open yet, wait up to this long, then give up. |
| `FORCE` | off | `1` to wait for the window no matter how far off. |
| `BOOK_RETRIES` | `6` | Attempts to find+book at open time (spots can vanish fast). |
| `HEADLESS` | `1` | `0` to watch the browser. |
| `DRY_RUN` | off | `1` to stop before the final confirm. |
| `PM_CALENDAR_URL` | Aaniin swim calendar | Override to book a different calendar. |
| `PW_EXECUTABLE_PATH` | — | Use a specific Chromium binary instead of Playwright's. |
| `PW_PROXY` / `HTTPS_PROXY` | — | Route the browser through an HTTPS proxy (rarely needed). |

## Scheduling

**Booking opens 21 hours before each session start**, so there are three
windows a week:

| Session | Window opens |
|---|---|
| Sunday 7:45 AM | Saturday 10:45 AM |
| Tuesday 8:00 AM | Monday 11:00 AM |
| Friday 8:00 AM | Thursday 11:00 AM |

The script figures this out automatically: on each run it looks at all
configured sessions, finds the one whose window is open (or opening within
`MAX_WAIT_MINUTES`), logs in, **waits for the exact open moment and pounces**,
retrying a few times in case the spot flickers as it goes live. If no window is
near, it exits with a note instead of hanging.

So run it a few minutes **before** each of the three open times (Sat 10:45,
Mon 11:00, Thu 11:00). One schedule per window; the script picks the right
session each time.

### Option A — GitHub Actions (runs in the cloud, no PC needed)

A workflow is included at `.github/workflows/book-swim.yml`.

1. Push this repo to GitHub.
2. In **Settings → Secrets and variables → Actions**, add repository secrets
   `PM_EMAIL` and `PM_PASSWORD`.
3. The workflow is preset with all three windows (Sat/Mon/Thu, firing ~10 min
   early and waiting for the open). Cron is **UTC** and ignores DST, so twice a
   year you swap the three active lines for the three commented winter lines
   (one hour later in UTC). All six are in the file.
4. You can also trigger it manually from the **Actions** tab. Screenshots are
   uploaded as an artifact for debugging.

> ⚠️ **GitHub's scheduled runs are often delayed 5–15+ minutes** at busy times.
> If these spots fill within seconds of opening, GitHub Actions may be too slow
> to reliably win one — a local cron (Option B) or a small always-on machine
> with accurate timing is a safer bet. The script's built-in wait helps, but it
> can only pounce once GitHub actually starts the job.

### Option B — cron on your own machine / a server

```cron
# LOCAL time (follows DST automatically, unlike the UTC-based Actions schedule).
# Each line starts a few minutes early; the script waits for the open & pounces.
35 10 * * 6  cd /path/to/CLAUDE && /usr/bin/node book-swim.mjs >> book-swim.log 2>&1  # Sat → Sun 7:45 AM
50 10 * * 1  cd /path/to/CLAUDE && /usr/bin/node book-swim.mjs >> book-swim.log 2>&1  # Mon → Tue 8:00 AM
50 10 * * 4  cd /path/to/CLAUDE && /usr/bin/node book-swim.mjs >> book-swim.log 2>&1  # Thu → Fri 8:00 AM
```

On macOS you can use `launchd` or `cron`; on Windows use Task Scheduler to run
`node book-swim.mjs`.

## Notifications

By default the result only appears in the run output:

- **Locally:** the terminal, ending with a `Summary: ✅ … / ❌ …` line (and in
  `book-swim.log` if you use the cron redirect above).
- **GitHub Actions:** the run's logs + the uploaded `screenshots` artifact.
  GitHub emails you automatically when a scheduled run **fails**, but not on
  success.

To get a **phone notification on every run** (success or failure), set
`NOTIFY_WEBHOOK_URL` to a Slack or Discord *Incoming Webhook* URL — the script
POSTs a one-line ✅/❌ summary to it:

- **Slack:** create an Incoming Webhook (https://api.slack.com/messaging/webhooks),
  then add it as `NOTIFY_WEBHOOK_URL` in `.env` (local) or as a repository
  secret (GitHub Actions — the workflow already passes it through).
- **Discord:** Server Settings → Integrations → Webhooks → New Webhook, copy
  the URL, use it the same way.

If you'd prefer email or a Google Calendar event instead of a webhook, that can
be added — the hook point is the `notify()` function in `book-swim.mjs`.

## Notes & limitations

- **This is not tested against the live authenticated site** (bookings require
  your personal login). Do the `DRY_RUN` first run above to confirm the flow,
  and adjust selectors/config if a step misses.
- The login session is cached in `.auth-state.json` so repeat runs skip login.
  Delete that file if you change your password.
- Secrets (`.env`, `.auth-state.json`) and `screenshots/` are git-ignored —
  don't commit them.
- Be a good citizen: this books **one** spot for **you**. Don't hammer the
  server or script mass bookings.
