# Aaniin Community Centre — Friday drop-in swim auto-booker

Automates booking a **Friday 8:00–9:00 AM** drop-in swim spot at Aaniin
Community Centre on the City of Markham
[PerfectMind / "BookMe4" portal](https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False).

The booking site is a JavaScript app behind a login, so this uses a real
browser (Playwright + Chromium) driven with your own account. Run it on a
schedule so it grabs the spot the moment the booking window opens.

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

Watch it log in, open the calendar, find the Friday 8:00 AM session, and reach
the confirmation screen. Screenshots are saved to `screenshots/`.

> **Important:** the exact button/label text on the authenticated PerfectMind
> pages can vary. The script uses forgiving, text-based selectors, but if a
> step can't find something, open the matching screenshot and adjust the
> relevant selector or the config below. The two most common tweaks are
> `SESSION_KEYWORDS` (to pick the right program if several run at 8 AM) and
> `TARGET_TIME` (must match the page text exactly, e.g. `8:00 AM`).

## Book for real

```bash
node book-swim.mjs
```

## Configuration (all optional — see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `PM_EMAIL` / `PM_PASSWORD` | — | **Required.** Your Markham account login. |
| `TARGET_WEEKDAY` | `5` | Day to book (0=Sun … 5=Fri … 6=Sat). |
| `TARGET_TIME` | `8:00 AM` | Session start time, exactly as shown on the page. |
| `SESSION_KEYWORDS` | `swim` | Comma-separated words that must **all** appear in the title. |
| `DAYS_AHEAD` | `7` | How many days ahead the booking window opens; the script targets the furthest Friday within it. |
| `HEADLESS` | `1` | `0` to watch the browser. |
| `DRY_RUN` | off | `1` to stop before the final confirm. |
| `PM_CALENDAR_URL` | Aaniin swim calendar | Override to book a different calendar. |
| `PW_EXECUTABLE_PATH` | — | Use a specific Chromium binary instead of Playwright's. |
| `PW_PROXY` / `HTTPS_PROXY` | — | Route the browser through an HTTPS proxy (rarely needed). |

## Scheduling

**Key question: when does Markham open the booking window?** Drop-in bookings
typically open a fixed number of days in advance, at a specific time. Set
`DAYS_AHEAD` to that number and schedule the script to run right when the window
opens, so you're first in line.

### Option A — GitHub Actions (runs in the cloud, no PC needed)

A workflow is included at `.github/workflows/book-swim.yml`.

1. Push this repo to GitHub.
2. In **Settings → Secrets and variables → Actions**, add repository secrets
   `PM_EMAIL` and `PM_PASSWORD`.
3. Edit the `cron:` line in the workflow to fire when your booking window opens.
   Cron is in **UTC**; Markham is UTC−4 (EDT, summer) / UTC−5 (EST, winter).
   Example: `1 12 * * *` ≈ 8:01 AM EDT.
4. You can also trigger it manually from the **Actions** tab. Screenshots are
   uploaded as an artifact for debugging.

### Option B — cron on your own machine / a server

```cron
# Every day at 12:01 AM local time (adjust to your booking-window opening).
1 0 * * *  cd /path/to/CLAUDE && /usr/bin/node book-swim.mjs >> book-swim.log 2>&1
```

On macOS you can use `launchd` or `cron`; on Windows use Task Scheduler to run
`node book-swim.mjs`.

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
