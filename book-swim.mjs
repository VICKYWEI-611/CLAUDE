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
const CONFIG = {
  email: process.env.PM_EMAIL || "",
  password: process.env.PM_PASSWORD || "",
  // The Aaniin Community Centre drop-in swim calendar you provided.
  calendarUrl:
    process.env.PM_CALENDAR_URL ||
    "https://cityofmarkham.perfectmind.com/Clients/BookMe4BookingPages/Classes?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False",
  // Which weekday to book. 5 = Friday (0=Sun .. 6=Sat).
  targetWeekday: Number(process.env.TARGET_WEEKDAY ?? 5),
  // Start time of the session, as it appears on the page, e.g. "8:00 AM".
  targetTime: process.env.TARGET_TIME || "8:00 AM",
  // Words that must appear in the session title to disambiguate (case-insensitive).
  // e.g. "Lane Swim", "Drop-In Swim", "Aquafit". Comma-separated = any-of match
  // is NOT used; ALL listed words must appear. Keep it minimal.
  titleKeywords: (process.env.SESSION_KEYWORDS || "swim")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // How many days ahead the booking window opens. The script targets the
  // furthest-out Friday that is <= today + this many days. City of Markham
  // drop-ins commonly open a few days ahead; adjust to match reality.
  daysAhead: Number(process.env.DAYS_AHEAD ?? 7),
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

/** Date (YYYY-MM-DD) of the target weekday within the booking window. */
function computeTargetDate() {
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(now.getDate() + CONFIG.daysAhead);
  // Walk backwards from the end of the window to find the target weekday.
  const d = new Date(windowEnd);
  while (d.getDay() !== CONFIG.targetWeekday) {
    d.setDate(d.getDate() - 1);
  }
  // If that lands before today, jump forward one week (shouldn't normally).
  if (d < now) d.setDate(d.getDate() + 7);
  return d;
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
async function findAndOpenSession(page, targetDate) {
  const timeRe = new RegExp(CONFIG.targetTime.replace(/\s+/g, "\\s*"), "i");
  const dayNameRe = new RegExp(
    targetDate.toLocaleDateString("en-CA", { weekday: "long" }),
    "i"
  );

  // Candidate rows: anything that mentions the target time.
  const timeMatches = page.getByText(timeRe);
  const count = await timeMatches.count();
  log(`Found ${count} element(s) mentioning "${CONFIG.targetTime}".`);

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

    const keywordsOk = CONFIG.titleKeywords.every((k) => text.includes(k));
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
    return;
  }

  if (CONFIG.dryRun) {
    log("🧪 DRY_RUN=1 — stopping before final confirm. Not submitting.");
    return;
  }

  log("Submitting final confirmation…");
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    confirmBtn.click(),
  ]);
  await page.waitForTimeout(2500);
}

async function main() {
  if (!CONFIG.email || !CONFIG.password) {
    return fail(
      "PM_EMAIL and PM_PASSWORD must be set (create a .env file — see .env.example)."
    );
  }

  const targetDate = computeTargetDate();
  log("Target session:", fmtLong(targetDate), "@", CONFIG.targetTime);
  log("Keywords:", CONFIG.titleKeywords.join(" + ") || "(none)");
  log("Mode:", CONFIG.dryRun ? "DRY RUN" : "LIVE", "| headless:", CONFIG.headless);

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

  try {
    log("Opening calendar…");
    await page.goto(CONFIG.calendarUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await ensureLoggedIn(page);
    // Persist the session for next time.
    await context.storageState({ path: CONFIG.storageStatePath }).catch(() => {});

    // Re-load the calendar in case login redirected us away.
    await page.goto(CONFIG.calendarUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    await navigateToDate(page, targetDate);
    await shot(page, "calendar");

    const opened = await findAndOpenSession(page, targetDate);
    if (!opened) {
      await shot(page, "session-not-found");
      return fail(
        `Could not find a "${CONFIG.titleKeywords.join(" ")}" session at ${CONFIG.targetTime} ` +
          `on ${fmtLong(targetDate)}. It may not be open for booking yet, or the ` +
          `keywords/time need adjusting. See the screenshot in ${CONFIG.screenshotDir}.`
      );
    }

    await completeBooking(page);
    await shot(page, "result");

    // Best-effort success detection.
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    if (/confirmed|booked|success|thank you|reservation/i.test(body) && !CONFIG.dryRun) {
      log("✅ Booking appears confirmed for", fmtLong(targetDate));
    } else if (CONFIG.dryRun) {
      log("🧪 Dry run finished. Review screenshots to confirm the flow reached checkout.");
    } else {
      log(
        "⚠️  Could not positively confirm the booking from page text. " +
          "Check the 'result' screenshot and your account."
      );
    }
  } catch (err) {
    await shot(page, "error");
    fail(err.stack || String(err));
  } finally {
    await context.storageState({ path: CONFIG.storageStatePath }).catch(() => {});
    await browser.close();
  }
}

main();
