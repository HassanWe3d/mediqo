/**
 * Mediqo FINAL end-to-end QA (Step 9.7).
 *
 * Unlike the per-page suites (which mock where determinism is needed), this
 * harness drives the REAL application against the REAL backend on every
 * step: browser geolocation via CDP GPS emulation, real AI analysis, real
 * matching, real PostgreSQL doctors + reviews. All navigation is done by
 * CLICKING — no URL manipulation inside the journeys.
 *
 * Part E — end-to-end journeys: tooth pain (full detail), skin rash,
 *   blurry vision (fresh state each), emergency, permission-deny fallback.
 * Part N — back/forward/refresh + direct URLs (graceful, never blank).
 * Part S — static source-of-truth audits (no frontend re-ranking etc.).
 *
 * Run from frontend/:  node tests/e2e-final-qa.mjs   (backend must be up)
 */
import puppeteer from "puppeteer-core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:8000";

let failures = 0;
let count = 0;
const report = (pass, name, detail = "") => {
  count++;
  if (name) console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!pass) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

/** Click by exact-then-contains label across buttons and links. */
const click = async (pg, label) => {
  const ok = await pg.evaluate((lbl) => {
    const els = [...document.querySelectorAll("button, a")];
    const el = els.find((b) => b.textContent.trim() === lbl) ?? els.find((b) => b.textContent.trim().includes(lbl));
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!ok) throw new Error(`element not found: ${label}`);
};
/** Click the first element whose text starts with the given prefix. */
const clickStartsWith = async (pg, prefix) => {
  const ok = await pg.evaluate((pfx) => {
    const els = [...document.querySelectorAll("button, a")];
    const el = els.find((b) => b.textContent.trim().startsWith(pfx));
    if (!el) return false;
    el.click();
    return true;
  }, prefix);
  if (!ok) throw new Error(`element not found: ${prefix}…`);
};
const typeInto = async (pg, selector, text) => {
  await pg.evaluate((sel) => {
    const input = document.querySelector(sel);
    if (!input) return;
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }, selector);
  await pg.keyboard.type(text, { delay: 2 });
};
const clearSession = (pg) => pg.evaluate(() => { try { sessionStorage.clear(); } catch {} });
const cards = (pg) => pg.evaluate(() => [...document.querySelectorAll("main h3")].map((h) => h.textContent.trim()));

/** Attach console + network tracking to a page. */
const track = (pg) => {
  const consoleErrors = [];
  const posts = [];
  pg.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  pg.on("response", (r) => {
    const method = r.request().method();
    const url = r.url();
    if (method === "POST" && url.includes(`${API}/`)) posts.push(`${method} ${new URL(url).pathname}`);
  });
  return { consoleErrors, posts };
};

/* ================================================================
 * PART E0 — PERMISSION DENY → MANUAL FALLBACK (before granting access)
 * ================================================================ */
console.log("\n== E0 · PERMISSION DENY → FALLBACK (nothing stuck) ==");
{
  const page = await browser.newPage();
  const { consoleErrors } = track(page);
  await clearSession(page);
  await page.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(500);
  await click(page, "Allow Location");
  // No permission granted in this context → the browser denies. Whatever the
  // outcome, the page must reach a state with a manual fallback available.
  await page
    .waitForFunction(
      () =>
        document.body.textContent.includes("Location access was denied") ||
        document.body.textContent.includes("Location detected") ||
        document.body.textContent.includes("couldn't determine your location"),
      { timeout: 10000 },
    )
    .catch(() => {});
  const t1 = await page.evaluate(() => document.body.textContent);
  const denied = t1.includes("Location access was denied") || t1.includes("couldn't determine your location");
  if (denied) {
    report(t1.includes("Enter location manually") || t1.includes("Try again"), "Deny → friendly state with manual fallback offered");
    await click(page, "Enter location manually");
  } else {
    report(true, "Permission auto-granted in headless — continuing via fallback check");
    await click(page, "Enter a different city");
  }
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 5000 });
  await typeInto(page, "form input", "Lucknow");
  await click(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 6000 });
  report(true, "Manual fallback after denial reaches Location detected — nothing stuck");
  report(consoleErrors.length === 0, "E0: no console errors", consoleErrors.join(" | "));
  await page.close();
}

/* ================================================================
 * PART E1 — JOURNEY 1: TOOTH PAIN (full detail, geolocation allowed)
 * ================================================================ */
console.log("\n== E1 · JOURNEY 1 — TOOTH PAIN ==");
await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);
const page = await browser.newPage();
const e1 = track(page);
await page.createCDPSession().then((c) => c.send("Emulation.setGeolocationOverride", { latitude: 26.8467, longitude: 80.9462, accuracy: 15 }));
{
  await clearSession(page);
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await sleep(600);
  report((await page.evaluate(() => document.body.textContent)).includes("Find the"), "Landing renders on fresh session");
  await click(page, "Find a Doctor"); // hero CTA
  await page.waitForFunction(() => location.pathname === "/location", { timeout: 5000 });
  report(true, "Hero CTA → /location (clicks only)");
  await click(page, "Allow Location");
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 10000 });
  report(true, "Browser geolocation (CDP GPS) → Location detected");
  await click(page, "Continue");
  await page.waitForFunction(() => location.pathname === "/problem", { timeout: 5000 });
  report(true, "Continue → /problem");
  await typeInto(page, "main textarea", "I have severe tooth pain since yesterday");
  await click(page, "Find suitable doctors");
  await page.waitForFunction(() => document.body.textContent.includes("km away"), { timeout: 20000 });
  report(true, "AI analysis + matching → real results");
  const t = await page.evaluate(() => document.body.textContent);
  report(t.includes("Specialty:") && t.includes("Dentist"), "Specialty chip: Dentist (AI)");
  report(t.includes("I have severe tooth pain since yesterday"), "Problem chip verbatim");
  const doctorCards = await cards(page);
  report(doctorCards.length >= 1 && doctorCards.length <= 5, `1–5 ranked doctors (${doctorCards.length})`);
  // Every card's specialty must be Dentist (from PostgreSQL).
  const specialties = await page.evaluate(() =>
    [...document.querySelectorAll("main li")].filter((li) => li.querySelector("h3")).map((li) => li.querySelector("p")?.textContent ?? ""),
  );
  report(specialties.every((s) => s.includes("Dentist")), "All result doctors are Dentists (database)");
  const matchPosts = e1.posts.filter((p) => p.includes("/match-doctors"));
  report(matchPosts.length === 1, "Exactly one POST /match-doctors", matchPosts.join(","));
}

/* Profile via View Profile */
let profilePath = "";
{
  const firstHref = await page.evaluate(() => document.querySelector("main a[href^='/doctor/']")?.getAttribute("href"));
  await click(page, "View Profile");
  await page.waitForFunction(() => /^\/doctor\/\d+$/.test(location.pathname), { timeout: 6000 });
  await page.waitForFunction(() => document.body.textContent.includes("Reviews"), { timeout: 6000 });
  await sleep(800);
  profilePath = await page.evaluate(() => location.pathname);
  report(profilePath === firstHref, `View Profile → ${profilePath} (same doctor)`);
  const apiDoctor = await fetch(`${API}/doctors/${profilePath.split("/")[2]}`).then((r) => r.json());
  const t = await page.evaluate(() => document.body.textContent);
  report(t.includes(apiDoctor.name), `Profile shows the real doctor (${apiDoctor.name})`);
  report(t.includes(apiDoctor.specialization), "Profile specialization from API");
  // Reviews belong to this doctor: compare rendered authors with the API set.
  await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="reviews-heading"] article').length >= 1, { timeout: 8000 }).catch(() => {});
  const apiReviews = await fetch(`${API}/doctors/${profilePath.split("/")[2]}/reviews?page=1&page_size=10`).then((r) => r.json());
  const apiNames = new Set(apiReviews.reviews.map((r) => r.reviewer_name));
  const rendered = await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-labelledby="reviews-heading"] article p')]
      .map((p) => p.textContent)
      .filter((x) => x?.startsWith("— "))
      .map((x) => x.replace(/^—\s+/, "").split("·")[0].trim()),
  );
  report(rendered.length >= 1 && rendered.every((n) => apiNames.has(n)), `All ${rendered.length} rendered reviews belong to this doctor (API cross-check)`, rendered.join(", "));
}

/* Back/forward/refresh probes */
console.log("\n== E2 · BACK / FORWARD / REFRESH ==");
{
  await clickStartsWith(page, "← Back to doctors");
  await page.waitForFunction(() => location.pathname === "/results", { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll("main h3").length >= 1, { timeout: 15000 });
  report(true, "Back to doctors → /results refetches cleanly");
  await page.goBack();
  await page.waitForFunction(() => /^\/doctor\/\d+$/.test(location.pathname), { timeout: 6000 });
  report(true, "Browser Back → profile again");
  await page.goForward();
  await page.waitForFunction(() => location.pathname === "/results", { timeout: 6000 });
  report(true, "Browser Forward → results again");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll("main h3").length >= 1, { timeout: 20000 });
  report(true, "Refresh on /results → matching re-runs, no blank page");
  await clickStartsWith(page, "← Back"); // top back → /problem
  await page.waitForFunction(() => location.pathname === "/problem", { timeout: 5000 });
  const draft = await page.evaluate(() => document.querySelector("main textarea")?.value);
  report(draft === "I have severe tooth pain since yesterday", "Back through the flow keeps the problem draft");
  await page.evaluate(() => { const a = [...document.querySelectorAll("a")].find((x) => x.getAttribute("aria-label") === "Mediqo home"); a?.click(); });
  await page.waitForFunction(() => location.pathname === "/", { timeout: 5000 });
  report(true, "Wordmark → home (journey exit intact)");
}
report(e1.consoleErrors.length === 0, "Journey 1: no console errors", e1.consoleErrors.join(" | "));

/* ================================================================
 * PART E3 — JOURNEYS 2 & 3: SKIN RASH, BLURRY VISION (fresh state)
 * ================================================================ */
const journey = async (problem, specialty, label) => {
  const p = await browser.newPage();
  const t3 = track(p);
  await clearSession(p);
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await sleep(500);
  await click(p, "Find a Doctor");
  await p.waitForFunction(() => location.pathname === "/location", { timeout: 5000 });
  await click(p, "Enter location manually");
  await p.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 5000 });
  await typeInto(p, "form input", "Lucknow");
  await click(p, "Continue");
  await p.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 6000 });
  await click(p, "Continue");
  await p.waitForFunction(() => location.pathname === "/problem", { timeout: 5000 });
  await typeInto(p, "main textarea", problem);
  await click(p, "Find suitable doctors");
  await p.waitForFunction(() => document.body.textContent.includes("km away"), { timeout: 20000 });
  const text = await p.evaluate(() => document.body.textContent);
  report(text.includes(specialty), `${label}: specialty = ${specialty}`);
  const doctorCards = await cards(p);
  report(doctorCards.length >= 1 && doctorCards.length <= 5, `${label}: ${doctorCards.length} doctors from PostgreSQL`);
  const matchPosts = t3.posts.filter((x) => x.includes("/match-doctors"));
  report(matchPosts.length === 1, `${label}: exactly one POST /match-doctors`, matchPosts.join(","));
  // Open the profile and come back.
  await click(p, "View Profile");
  await p.waitForFunction(() => /^\/doctor\/\d+$/.test(location.pathname), { timeout: 6000 });
  await p.waitForFunction(() => document.body.textContent.includes("Reviews"), { timeout: 6000 });
  report(true, `${label}: profile opens with reviews section`);
  await clickStartsWith(p, "← Back to doctors");
  await p.waitForFunction(() => location.pathname === "/results", { timeout: 5000 });
  await p.waitForFunction(() => document.querySelectorAll("main h3").length >= 1, { timeout: 15000 });
  report(true, `${label}: back to results intact`);
  report(t3.consoleErrors.length === 0, `${label}: no console errors`, t3.consoleErrors.join(" | "));
  await p.close();
};
console.log("\n== E3 · JOURNEYS 2 & 3 ==");
await journey("I have a skin rash and irritation.", "Dermatologist", "Rash journey");
await journey("I have blurry vision.", "Ophthalmologist", "Vision journey");

/* ================================================================
 * PART E4 — EMERGENCY JOURNEY
 * ================================================================ */
console.log("\n== E4 · EMERGENCY ==");
{
  const p = await browser.newPage();
  const t4 = track(p);
  await clearSession(p);
  await p.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(500);
  await click(p, "Enter location manually");
  await typeInto(p, "form input", "Lucknow");
  await click(p, "Continue");
  await p.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 6000 });
  await click(p, "Continue");
  await p.waitForFunction(() => location.pathname === "/problem", { timeout: 5000 });
  await typeInto(p, "main textarea", "crushing chest pain and I feel faint right now");
  await click(p, "Find suitable doctors");
  await p.waitForFunction(() => document.body.textContent.includes("immediate medical attention"), { timeout: 15000 });
  const text = await p.evaluate(() => document.body.textContent);
  report(text.includes("Please contact your local emergency number"), "Emergency guidance shown");
  report(!(await cards(p)).length, "No doctor ranking shown");
  report((await p.evaluate(() => location.pathname)) === "/problem", "Stays on /problem — matching never invoked");
  report(t4.posts.every((x) => !x.includes("/match-doctors")), "Zero POST /match-doctors in the emergency path");
  report(t4.consoleErrors.length === 0, "Emergency: no console errors", t4.consoleErrors.join(" | "));
  await p.close();
}

/* ================================================================
 * PART N — DIRECT URLS (fresh page, clean state)
 * ================================================================ */
console.log("\n== N · DIRECT URLS ==");
{
  const p = await browser.newPage();
  const tN = track(p);
  await clearSession(p);

  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  report((await p.evaluate(() => location.pathname)) === "/", "/ renders");
  await p.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(400);
  report((await p.evaluate(() => document.body.textContent)).includes("Where are you?"), "/location renders");
  await p.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  report((await p.evaluate(() => location.pathname)) === "/location", "/problem without state → /location");
  await p.goto(BASE + "/results", { waitUntil: "networkidle0" });
  report((await p.evaluate(() => location.pathname)) === "/location", "/results without state → /location");

  const list = await fetch(`${API}/doctors?page=1&page_size=1`).then((r) => r.json());
  const validId = list.items[0].id;
  await p.goto(`${BASE}/doctor/${validId}`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => document.body.textContent.includes("Reviews"), { timeout: 8000 });
  report(true, `/doctor/${validId} (valid, direct) renders full profile`);
  await p.goto(`${BASE}/doctor/999999`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => document.body.textContent.includes("We couldn't find this doctor's profile."), { timeout: 6000 });
  report(true, "/doctor/999999 → not-found state");
  await p.goto(`${BASE}/doctor/abc`, { waitUntil: "networkidle0" });
  report((await p.evaluate(() => document.body.textContent)).includes("We couldn't find this doctor's profile."), "/doctor/abc → not-found (no crash)");
  await p.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle0" });
  const body = await p.evaluate(() => document.body.textContent);
  report(body.length > 100, "Unknown route renders (no blank page)", `${body.length} chars`);

  // With location state but no problem: /results must bounce to /problem.
  await p.evaluate(() => {
    sessionStorage.setItem("mediqo.flow.location", JSON.stringify({ method: "city", label: "Lucknow", latitude: 26.8467, longitude: 80.9462 }));
  });
  await p.goto(`${BASE}/results`, { waitUntil: "networkidle0" });
  report((await p.evaluate(() => location.pathname)) === "/problem", "/results with location only → /problem");
  // Chrome logs a network-level "Failed to load resource: 404" for the
  // deliberately-404 endpoints this section requests; the app itself showed
  // friendly states. Filter exactly that expected artifact.
  const unexpected = tN.consoleErrors.filter((m) => !/Failed to load resource.*404/.test(m));
  report(unexpected.length === 0, "Direct URLs: no unexpected console errors", unexpected.join(" | "));
  await p.close();
}

/* ================================================================
 * PART S — STATIC SOURCE-OF-TRUTH AUDITS (no mocks, just reading src)
 * ================================================================ */
console.log("\n== S · STATIC AUDITS ==");
const srcRoot = "src";
const srcFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|css)$/.test(entry)) srcFiles.push(full);
  }
};
walk(srcRoot);
const forbidden = [
  { pattern: /\.sort\(/, why: "Frontend never re-sorts backend ranking" },
  { pattern: /match_score\s*[+\-*]/, why: "Frontend never recomputes match scores" },
  { pattern: /distance_km\s*[+\-*]/, why: "Frontend never recomputes distance" },
  { pattern: /haversine|Math\.asin|Math\.atan2/, why: "No distance math in the frontend" },
  { pattern: /"Dr\. |'Dr\. /, why: "No hardcoded doctor names in production code" },
  { pattern: /Very patient and explained|Quick diagnosis and gentle/, why: "No hardcoded review text in production code" },
  { pattern: /10,?000\+|1M patients|98% satisfaction/, why: "No fake statistics anywhere" },
];
for (const { pattern, why } of forbidden) {
  const hits = srcFiles.filter((f) => pattern.test(readFileSync(f, "utf8")));
  report(hits.length === 0, why, hits.length ? hits.join(", ") : "clean");
}
// vite-env.d.ts legitimately declares the env typing — runtime code must
// reference the base URL only through the API client.
const runtimeSrc = srcFiles.filter((f) => !f.endsWith(".d.ts"));
const apiBaseUsages = runtimeSrc.filter((f) => /VITE_API_BASE_URL/.test(readFileSync(f, "utf8")));
report(apiBaseUsages.length === 1 && apiBaseUsages[0].endsWith("api.ts"), "API base URL referenced only in the API client", apiBaseUsages.join(", "));

await browser.close();
console.log(`\n===== FINAL E2E QA: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
