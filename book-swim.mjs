#!/usr/bin/env node
// Auto-books a drop-in swim spot at Aaniin Community Centre (City of Markham,
// PerfectMind / "BookMe4" portal).
//
// Usage:
//   node book-swim.mjs               # book the next eligible Friday 8:00 AM slot
//   DRY_RUN=1 node book-swim.mjs     # do everything EXCEPT the final confirm
//   HEADLESS=0 node book-swim.mjs    # watch it run in a visible browser
//
// Configure via environment variables (see .env.example). At minimum you must
// set PM_EMAIL and PM_PASSWORD (your City of Markham account login).

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) --------------------------------------
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// --- configuration ----------------------------------------------------------
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const CONFIG = {
  email: process.env.PM_EMAIL || "",
  password: process.env.PM_PASSWORD || "",
  // The Aaniin Community Centre drop-in swim calendar you provided.
  calendarUrl:
    process.env.PM_CALENDAR_URL ||
    "https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False",
  // The recurring sessions to book. Each run books whichever one's booking
  // window is open (or opening within MAX_WAIT_MINUTES). Format:
  //   "Day H:MM AM/PM"  separated by ";"  — optional "| keywords" per entry.
  // Override with the SESSIONS env var.
  sessions: parseSessions(
    process.env.SESSIONS || "Sun 7:45 AM; Tue 8:00 AM; Fri 8:00 AM"
  ),
  // Default words that must appear in a session title (case-insensitive, ALL
  // must match). Used when a session entry doesn't specify its own keywords.
  titleKeywords: (process.env.SESSION_KEYWORDS || "swim")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Booking opens this many hours before the session start time.
  // Friday 8:00 AM session => opens Thursday 11:00 AM (8:00 - 21h).
  openHoursBefore: Number(process.env.OPEN_HOURS_BEFORE ?? 21),
  // If the booking window hasn't opened yet, wait for it — but only up to this
  // many minutes. If it's further out than this, the script exits with a note
  // (so a mis-timed run doesn't hang). Set FORCE=1 to wait regardless.
  maxWaitMinutes: Number(process.env.MAX_WAIT_MINUTES ?? 30),
  force: process.env.FORCE === "1",
  // Right after the window opens, spots can vanish in seconds. Retry the
  // find+book this many times before giving up.
  bookRetries: Number(process.env.BOOK_RETRIES ?? 6),
  bookRetryDelayMs: Number(process.env.BOOK_RETRY_DELAY_MS ?? 2500),
  headless: process.env.HEADLESS !== "0",
  dryRun: process.env.DRY_RUN === "1",
  timeoutMs: Number(process.env.STEP_TIMEOUT_MS ?? 30000),
  screenshotDir: process.env.SCREENSHOT_DIR || path.join(__dirname, "screenshots"),
  // Reuse a saved login session so we don't log in every run.
  storageStatePath:
    process.env.STORAGE_STATE || path.join(__dirname, ".auth-state.json"),
  // Optional: point at a specific Chromium binary (e.g. a pre-installed one).
  // Leave unset to use the browser Playwright installed.
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  // Optional: route the browser through an HTTPS proxy (needed in some CI /
  // sandbox environments; not needed on a normal home machine).
  proxyServer: process.env.PW_PROXY || process.env.HTTPS_PROXY || undefined,
};

const log = (...a) => console.log(new Date().toISOString(), "-", ...a);

function fail(msg) {
  console.error("\n❌ " + msg);
  process.exitCode = 1;
}

/** Parse a "8:00 AM" style time into 24h {hour, minute}. */
function parseTime(s) {
  const m = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(s || "");
  if (!m) return { hour: 8, minute: 0 };
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ap = (m[3] || "").toLowerCase();
  if (ap.startsWith("p") && hour < 12) hour += 12;
  if (ap.startsWith("a") && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * Parse a sessions spec like "Sun 7:45 AM; Tue 8:00 AM | Lane Swim; Fri 8:00 AM"
 * into [{ weekday, timeLabel, hour, minute, keywords }]. `keywords` is null
 * when the entry doesn't override the default SESSION_KEYWORDS.
 */
function parseSessions(spec) {
  const out = spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [timePart, kwPart] = entry.split("|");
      const m = /^\s*([a-z]{3,9})\.?\s+(.+?)\s*$/i.exec(timePart || "");
      if (!m) throw new Error(`Bad session spec: "${entry}"`);
      const weekday = WEEKDAYS[m[1].slice(0, 3).toLowerCase()];
      if (weekday === undefined) throw new Error(`Unknown weekday in: "${entry}"`);
      const timeLabel = m[2].trim();
      const keywords = kwPart
        ? kwPart.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)
        : null;
      return { weekday, timeLabel, ...parseTime(timeLabel), keywords };
    });
  if (out.length === 0) throw new Error("No sessions configured.");
  return out;
}

/**
 * The next occurrence of a session's weekday at its time that is still in the
 * future (local time). Returns a Date at the session start moment.
 */
function nextOccurrence(session, now = new Date()) {
  const d = new Date(now);
  d.setHours(session.hour, session.minute, 0, 0);
  while (d.getDay() !== session.weekday || d <= now) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** The moment the booking window opens for a given session start. */
function computeOpenTime(sessionStart) {
  return new Date(sessionStart.getTime() - CONFIG.openHoursBefore * 3600 * 1000);
}

/** Sleep until `when`, logging a countdown; refreshes are handled by caller. */
async function waitUntil(when, label) {
  let remaining = when.getTime() - Date.now();
  log(`Waiting ~${Math.round(remaining / 1000)}s until ${label}…`);
  while (Date.now() < when.getTime()) {
    remaining = when.getTime() - Date.now();
    const step = Math.min(remaining, 15000);
    // Chunked sleep so long waits still show progress.
    await new Promise((r) => setTimeout(r, Math.max(step, 250)));
    const left = when.getTime() - Date.now();
    if (left > 0 && left % 60000 < 15000) log(`  …${Math.round(left / 1000)}s to go`);
  }
}

function fmtLong(d) {
  return d.toLocaleDateString("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

async function shot(page, name) {
  try {
    fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    const file = path.join(CONFIG.screenshotDir, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log("📸 screenshot:", file);
  } catch (e) {
    log("(could not screenshot)", e.message);
  }
}

/**
 * Ensure we are logged in. PerfectMind BookMe4 pages expose a "Login" link in
 * the header; clicking it reveals an email/password form. Selectors here are
 * intentionally forgiving — confirm them on your first HEADLESS=0 run.
 */
async function ensureLoggedIn(page) {
  // If a "Login" / "Sign In" control is visible, we're not logged in yet.
  const loginTrigger = page
    .getByRole("link", { name: /log ?in|sign ?in/i })
    .or(page.getByRole("button", { name: /log ?in|sign ?in/i }))
    .first();

  if ((await loginTrigger.count()) === 0) {
    log("Already appears logged in (no login control found).");
    return;
  }

  log("Logging in as", CONFIG.email);
  await loginTrigger.click().catch(() => {});
  await page.waitForTimeout(1500);

  const emailField = page
    .getByRole("textbox", { name: /e-?mail|user/i })
    .or(page.locator('input[type="email"], input[name*="mail" i], input[id*="mail" i]'))
    .first();
  const passField = page
    .locator('input[type="password"], input[name*="pass" i], input[id*="pass" i]')
    .first();

  await emailField.waitFor({ timeout: CONFIG.timeoutMs });
  await emailField.fill(CONFIG.email);
  await passField.fill(CONFIG.password);

  const submit = page
    .getByRole("button", { name: /log ?in|sign ?in|submit/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'))
    .first();
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    submit.click(),
  ]);
  await page.waitForTimeout(2000);

  // Sanity check: the login control should be gone now.
  if ((await loginTrigger.count()) > 0 && (await loginTrigger.isVisible().catch(() => false))) {
    await shot(page, "login-maybe-failed");
    throw new Error(
      "Login did not appear to succeed. Check PM_EMAIL/PM_PASSWORD and the login selectors."
    );
  }
  log("✅ Logged in.");
}

/**
 * Navigate the Classes calendar to the target date. BookMe4 renders sessions
 * grouped by day; there's usually a date picker or day navigation. We try a
 * few strategies and fall back to scanning whatever is on screen.
 */
async function navigateToDate(page, targetDate) {
  const dayNum = String(targetDate.getDate());
  const monthName = targetDate.toLocaleDateString("en-CA", { month: "long" });

  // Strategy: many BookMe4 calendars have a date input or a visible day header.
  // Try to click a day cell / header matching the target date's day number.
  const dateInput = page.locator('input[type="date"]').first();
  if ((await dateInput.count()) > 0) {
    const iso = targetDate.toISOString().slice(0, 10);
    await dateInput.fill(iso).catch(() => {});
    await page.waitForTimeout(1500);
    return;
  }

  // Otherwise, page forward until a header mentioning the target date appears.
  const targetHeaderRe = new RegExp(`${monthName}\\s+0?${dayNum}\\b`, "i");
  for (let i = 0; i < 8; i++) {
    if (await page.getByText(targetHeaderRe).first().isVisible().catch(() => false)) {
      log("Reached date view containing", monthName, dayNum);
      return;
    }
    const next = page
      .getByRole("button", { name: /next|forward|›|»/i })
      .or(page.getByRole("link", { name: /next|forward|›|»/i }))
      .first();
    if ((await next.count()) === 0) break;
    await next.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  log(
    "Note: could not confirm a date header for",
    monthName,
    dayNum,
    "- will match the session by day/time/keywords on the current view."
  );
}

/**
 * Locate the session card for the target day + time + keywords and open it.
 * Returns the clickable "book" affordance found within, or null.
 */
async function findAndOpenSession(page, targetDate, session) {
  const timeRe = new RegExp(session.timeLabel.replace(/\s+/g, "\\s*"), "i");
  const keywords = session.keywords || CONFIG.titleKeywords;
  const dayNameRe = new RegExp(
    targetDate.toLocaleDateString("en-CA", { weekday: "long" }),
    "i"
  );

  // Candidate rows: anything that mentions the target time.
  const timeMatches = page.getByText(timeRe);
  const count = await timeMatches.count();
  log(`Found ${count} element(s) mentioning "${session.timeLabel}".`);

  for (let i = 0; i < count; i++) {
    const node = timeMatches.nth(i);
    // Climb to a reasonably-sized container (the session card/row).
    const card = node
      .locator(
        "xpath=ancestor-or-self::*[self::li or self::tr or contains(@class,'row') or contains(@class,'card') or contains(@class,'event') or contains(@class,'session')][1]"
      )
      .first();
    const container = (await card.count()) > 0 ? card : node;
    const text = ((await container.innerText().catch(() => "")) || "").toLowerCase();

    const keywordsOk = keywords.every((k) => text.includes(k));
    // Day check is best-effort: the card may not repeat the weekday, so we
    // only reject if it clearly names a DIFFERENT weekday.
    const namesAWeekday = /\b(sun|mon|tue|wed|thu|fri|sat)\w*day\b/i.test(text);
    const dayOk = !namesAWeekday || dayNameRe.test(text);

    if (!keywordsOk || !dayOk) continue;

    log("Matched session card:", text.replace(/\s+/g, " ").slice(0, 120));

    const bookBtn = container
      .getByRole("button", { name: /book|reserve|sign ?up|register|add/i })
      .or(container.getByRole("link", { name: /book|reserve|sign ?up|register|add|details|more/i }))
      .first();

    if ((await bookBtn.count()) > 0) {
      await bookBtn.scrollIntoViewIfNeeded().catch(() => {});
      await bookBtn.click();
      await page.waitForTimeout(1500);
      return true;
    }
    // No obvious button — click the card itself to open its detail view.
    await container.click().catch(() => {});
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

/**
 * On the session detail / booking view, drive the reservation to completion.
 * Stops before the final confirm when DRY_RUN=1.
 */
async function completeBooking(page) {
  // Step through the common BookMe4 booking buttons in order. Each step is
  // optional; we click whatever is present.
  const steps = [
    { label: "Book Now", re: /book ?now|reserve|sign ?up|register/i, isFinal: false },
    { label: "Select attendee / continue", re: /continue|next|proceed/i, isFinal: false },
  ];

  for (const step of steps) {
    const btn = page.getByRole("button", { name: step.re })
      .or(page.getByRole("link", { name: step.re }))
      .first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      log("Clicking:", step.label);
      await btn.click().catch(() => {});
      await page.waitForTimeout(1800);
    }
  }

  // Make sure the account holder is selected as the attendee, if a checklist
  // of names is shown.
  const attendeeCheckbox = page
    .getByRole("checkbox", { name: new RegExp(CONFIG.email.split("@")[0], "i") })
    .first();
  if ((await attendeeCheckbox.count()) > 0 && !(await attendeeCheckbox.isChecked().catch(() => false))) {
    await attendeeCheckbox.check().catch(() => {});
  }

  await shot(page, "before-confirm");

  const confirmBtn = page
    .getByRole("button", { name: /confirm|checkout|place order|complete|finish|pay|submit/i })
    .or(page.getByRole("link", { name: /confirm|checkout|place order|complete|finish/i }))
    .first();

  if ((await confirmBtn.count()) === 0) {
    log(
      "No explicit confirm button found. The booking may already be complete, " +
        "or the page needs a selector tweak. Check the screenshot."
    );
    return "no-confirm";
  }

  if (CONFIG.dryRun) {
    log("🧪 DRY_RUN=1 — stopping before final confirm. Not submitting.");
    return "dry";
  }

  log("Submitting final confirmation…");
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    confirmBtn.click(),
  ]);
  await page.waitForTimeout(2500);
  return "submitted";
}

/** Short filename-safe tag for a session, e.g. "fri-8-00-am". */
function slug(session) {
  return `${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][session.weekday]}-${session.timeLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * Wait for one session's window to open (if needed), then find + book it,
 * retrying through the opening rush. Returns { ok, note }.
 */
async function bookOne(page, cand) {
  const { session, start, open } = cand;
  const label = `${fmtLong(start)} @ ${session.timeLabel}`;
  const tag = slug(session);

  if (open.getTime() > Date.now() && !CONFIG.dryRun) {
    await waitUntil(open, `booking window opens for ${label}`);
    log("🟢 Window open — going for it.");
  }

  for (let attempt = 1; attempt <= CONFIG.bookRetries; attempt++) {
    log(`[${tag}] Attempt ${attempt}/${CONFIG.bookRetries}…`);
    // Fresh load each attempt for up-to-date availability.
    await page.goto(CONFIG.calendarUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await navigateToDate(page, start);
    if (attempt === 1) await shot(page, `${tag}-calendar`);

    const opened = await findAndOpenSession(page, start, session);
    if (!opened) {
      log(`[${tag}] Session not found/openable on this attempt.`);
      if (attempt < CONFIG.bookRetries) {
        await page.waitForTimeout(CONFIG.bookRetryDelayMs);
        continue;
      }
      await shot(page, `${tag}-not-found`);
      return {
        ok: false,
        note:
          `Could not find "${(session.keywords || CONFIG.titleKeywords).join(" ")}" at ` +
          `${session.timeLabel} on ${fmtLong(start)} after ${CONFIG.bookRetries} attempts ` +
          `(full, not open yet, or keywords/time need adjusting).`,
      };
    }

    const status = await completeBooking(page);
    await shot(page, `${tag}-result-${attempt}`);

    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    const looksConfirmed = /confirmed|booked|success|thank you|reservation/i.test(body);

    if (CONFIG.dryRun) {
      log(`🧪 [${tag}] Dry run reached checkout — review screenshots.`);
      return { ok: true, note: `dry run for ${label}` };
    }
    if (status === "submitted" && looksConfirmed) {
      log(`✅ [${tag}] Booking confirmed for ${label}`);
      return { ok: true, note: `confirmed ${label}` };
    }
    if (status === "submitted") {
      log(`[${tag}] Submitted, but couldn't positively confirm — check the screenshot.`);
      return { ok: true, note: `submitted (unconfirmed) ${label}` };
    }
    log(`[${tag}] Booking didn't complete on this attempt.`);
    if (attempt < CONFIG.bookRetries) await page.waitForTimeout(CONFIG.bookRetryDelayMs);
  }
  return { ok: false, note: `exhausted ${CONFIG.bookRetries} attempts for ${label}` };
}

async function main() {
  if (!CONFIG.email || !CONFIG.password) {
    return fail(
      "PM_EMAIL and PM_PASSWORD must be set (create a .env file — see .env.example)."
    );
  }

  const now = new Date();
  const maxWaitMs = CONFIG.maxWaitMinutes * 60000;

  // For each configured session, find the next occurrence + its open moment.
  const candidates = CONFIG.sessions
    .map((session) => {
      const start = nextOccurrence(session, now);
      const open = computeOpenTime(start);
      return { session, start, open, msUntilOpen: open.getTime() - now.getTime() };
    })
    .sort((a, b) => a.open - b.open);

  log("Configured sessions & next booking windows:");
  for (const c of candidates) {
    log(
      `  • ${fmtLong(c.start)} @ ${c.session.timeLabel} — opens ` +
        `${c.open.toLocaleString("en-CA")} (${Math.round(c.msUntilOpen / 60000)} min)`
    );
  }
  log("Mode:", CONFIG.dryRun ? "DRY RUN" : "LIVE", "| headless:", CONFIG.headless);

  // Which sessions should we act on now? Any whose window is open, or opening
  // within MAX_WAIT_MINUTES. In dry-run we just exercise the soonest one.
  let targets;
  if (CONFIG.dryRun) {
    targets = [candidates[0]];
  } else {
    targets = candidates.filter((c) => c.msUntilOpen <= maxWaitMs);
    if (targets.length === 0) {
      if (!CONFIG.force) {
        const soonest = candidates[0];
        return fail(
          `No booking window is open or within MAX_WAIT_MINUTES=${CONFIG.maxWaitMinutes}. ` +
            `Soonest is ${fmtLong(soonest.start)} @ ${soonest.session.timeLabel}, opening ` +
            `${soonest.open.toLocaleString("en-CA")} ` +
            `(${Math.round(soonest.msUntilOpen / 60000)} min from now). Schedule closer to ` +
            `an open time, raise MAX_WAIT_MINUTES, or set FORCE=1.`
        );
      }
      targets = [candidates[0]];
    }
  }
  log(
    "Acting on:",
    targets.map((c) => `${fmtLong(c.start)} @ ${c.session.timeLabel}`).join("; ")
  );

  const launchOpts = { headless: CONFIG.headless };
  if (CONFIG.executablePath) launchOpts.executablePath = CONFIG.executablePath;
  if (CONFIG.proxyServer) launchOpts.proxy = { server: CONFIG.proxyServer };
  const browser = await chromium.launch(launchOpts);
  const contextOpts = { viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true };
  if (fs.existsSync(CONFIG.storageStatePath)) {
    contextOpts.storageState = CONFIG.storageStatePath;
    log("Reusing saved login session.");
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);

  const results = [];
  try {
    log("Opening calendar…");
    await page.goto(CONFIG.calendarUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await ensureLoggedIn(page);
    await context.storageState({ path: CONFIG.storageStatePath }).catch(() => {});

    for (const cand of targets) {
      const r = await bookOne(page, cand);
      results.push(r);
    }
  } catch (err) {
    await shot(page, "error");
    fail(err.stack || String(err));
  } finally {
    await context.storageState({ path: CONFIG.storageStatePath }).catch(() => {});
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  log("Summary:", results.map((r) => (r.ok ? "✅ " : "❌ ") + r.note).join(" | ") || "(nothing attempted)");
  if (failed.length > 0) {
    fail(`${failed.length} of ${results.length} booking(s) did not complete. See ${CONFIG.screenshotDir}.`);
  }
}

main();
