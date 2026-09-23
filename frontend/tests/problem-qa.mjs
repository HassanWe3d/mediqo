/**
 * Mediqo problem-experience QA harness (Step 9.4 verification).
 *
 * Part A — deterministic: mocks the /analyze-problem endpoint (success,
 *   emergency, HTTP failure, network failure) and seeds flow state, so
 *   every spec scenario runs without a real AI provider.
 * Part B — live: the REAL FastAPI offline AI provider classifies real
 *   descriptions end-to-end.
 * Part C — responsive sweep, axe accessibility, keyboard, reduced motion.
 *
 * The mock is installed ONCE per page and configured per navigation via
 * `window.name` (survives navigations), avoiding the accumulate-on-
 * evaluateOnNewDocument problem that plagued earlier harnesses.
 *
 * Run from frontend/:  node tests/problem-qa.mjs
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5173";
const axeSource = readFileSync("node_modules/axe-core/axe.min.js", "utf8");

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

const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const clickButton = async (pg, label) => {
  const ok = await pg.evaluate(
    (lbl) => {
      const btns = [...document.querySelectorAll("button")];
      const btn =
        btns.find((b) => b.textContent.trim() === lbl) ?? btns.find((b) => b.textContent.trim().includes(lbl));
      if (!btn) return false;
      btn.click();
      return true;
    },
    label,
  );
  if (!ok) throw new Error(`button not found: ${label}`);
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
const bodyText = (pg) => (pg ?? page).evaluate(() => document.body.textContent);
const buttonLabels = (pg) => (pg ?? page).evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()));

/** Install the universal, config-driven mock (once per page). */
const installMocks = (pg) =>
  pg.evaluateOnNewDocument(() => {
    let cfg = {};
    try {
      cfg = JSON.parse(window.name || "{}");
    } catch {
      cfg = {};
    }

    const realFetch = window.fetch.bind(window);
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    window.__apiCalls = [];
    window.__analyzeResolve = null;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : null;
      window.__apiCalls.push(`${init?.method ?? "GET"} ${url} ${body ? JSON.stringify(body) : ""}`);
      if (url.includes("/analyze-problem")) {
        if (cfg.liveAnalyze) return realFetch(input, init); // real backend AI
        if (cfg.analyzeStatus === 0) throw new TypeError("Failed to fetch");
        if (cfg.defer) {
          return new Promise((resolve) => {
            window.__analyzeResolve = () => resolve(reply(cfg.analyzeStatus ?? 200, cfg.analyzeBody));
          });
        }
        return reply(cfg.analyzeStatus ?? 200, cfg.analyzeBody);
      }
      if (url.includes("/location/manual")) {
        const known = { lucknow: [26.8467, 80.9462], kanpur: [26.4499, 80.3319] };
        const hit = known[body.city.trim().toLowerCase()];
        if (hit) return reply(200, { valid: true, city: body.city, latitude: hit[0], longitude: hit[1] });
        return reply(400, { detail: "This location is not currently supported." });
      }
      return realFetch(input, init);
    };

    try {
      if (cfg.resetStorage) {
        sessionStorage.clear();
        if (cfg.seedLocation) sessionStorage.setItem("mediqo.flow.location", JSON.stringify(cfg.seedLocation));
      }
    } catch {
      /* ignore */
    }
  });

/** Configure the next navigation(s) for a page. */
const setCfg = (pg, cfg) => pg.evaluate((c) => { window.name = JSON.stringify(c); }, cfg);
const clearCfg = (pg) => pg.evaluate(() => { window.name = ""; });

const LUCKNOW = { method: "city", label: "Lucknow", latitude: 26.8467, longitude: 80.9462 };
const DEFAULT_ANALYSIS = {
  specialization: "Dentist",
  urgency: "normal",
  summary: "The user is describing tooth pain and may need dental evaluation.",
  possible_keywords: ["tooth pain"],
};
const gotoProblem = async (pg = page) => {
  await pg.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  await sleep(750);
};
const stored = (pg = page) =>
  pg.evaluate(() => ({
    problem: sessionStorage.getItem("mediqo.flow.problem"),
    analysis: JSON.parse(sessionStorage.getItem("mediqo.flow.analysis") ?? "null"),
    location: JSON.parse(sessionStorage.getItem("mediqo.flow.location") ?? "null"),
  }));

/* ---- P1: renders with location state, no API on load ---- */
console.log("\n== P1 · RENDER ==");
installMocks(page);
await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW });
await gotoProblem();
{
  const t = await bodyText();
  report((await page.evaluate(() => location.pathname)) === "/problem", "Opens at /problem");
  report(t.includes("MEDIQO."), "Wordmark renders");
  report(t.includes("What are you experiencing?"), "Heading renders");
  report(t.includes("You don't need to know which specialist you need."), "Differentiator supporting copy renders");
  report(t.includes("Location confirmed: Lucknow") && t.includes("Change"), "Location chip + Change action render");
  report(await page.evaluate(() => !!document.querySelector("main textarea")), "Textarea renders");
  report(t.includes("Your symptoms or concern"), "Textarea has a visible label");
  report((await buttonLabels()).includes("Find suitable doctors"), 'Primary CTA "Find suitable doctors" renders');
  report(t.includes("Not sure how to phrase it? Try:") && t.includes("Tooth pain") && t.includes("Child has fever"), "Example prompts render");
  report(t.includes("not a diagnosis"), "Non-diagnostic microcopy renders");
  report(t.includes("Step 2 of 3"), "Step eyebrow renders");
  const calls = await page.evaluate(() => window.__apiCalls ?? []);
  report(calls.length === 0, "No API calls on page load", calls.join(" | "));
  report(!t.includes("26.8467"), "Raw coordinates not exposed");
}

/* ---- P2: missing location redirects to /location ---- */
console.log("\n== P2 · GUARD ==");
{
  await setCfg(page, { resetStorage: true });
  await gotoProblem();
  report((await page.evaluate(() => location.pathname)) === "/location", "Without location, /problem redirects to /location");
}

/* ---- P3: empty + too-short input rejected, no API call ---- */
console.log("\n== P3 · VALIDATION ==");
{
  await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW, defer: true });
  await gotoProblem();
  await clickButton(page, "Find suitable doctors");
  await sleep(200);
  report((await bodyText()).includes("Please describe what you're experiencing."), "Empty input → inline message");
  report((await page.evaluate(() => document.querySelector("main textarea")?.getAttribute("aria-invalid"))) === "true", "aria-invalid set");
  report((await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA", "Focus returned to textarea");
  report((await page.evaluate(() => window.__apiCalls.length)) === 0, "No API call for empty input");
  await typeInto(page, "main textarea", "ab");
  await sleep(150);
  // The designed UX for too-short input: the CTA is DISABLED (submit is
  // unreachable) and a polite live hint explains why — no error state needed.
  report(
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Find suitable doctors"))?.disabled === true,
    ),
    "CTA disabled for too-short input",
  );
  report((await bodyText()).includes("Please add a little more detail."), "Live hint shown for too-short input");
  await clickButton(page, "Find suitable doctors"); // click is a no-op on a disabled button
  await sleep(150);
  report((await page.evaluate(() => window.__apiCalls.length)) === 0, "No API call for too-short input");
}

/* ---- P4: character limit + counter ---- */
console.log("\n== P4 · LIMIT ==");
{
  const longText = "word ".repeat(210); // 1050 chars > backend limit
  await typeInto(page, "main textarea", longText);
  const len = await page.evaluate(() => document.querySelector("main textarea")?.value.length);
  report(len === 1000, "Input capped at backend limit (1000)", String(len));
  report((await bodyText()).includes("0 left"), "Counter shows remaining characters");
}

/* ---- P5: example chips populate without submitting ---- */
console.log("\n== P5 · EXAMPLES ==");
{
  await clickButton(page, "Skin rash");
  await sleep(80);
  const value = await page.evaluate(() => document.querySelector("main textarea")?.value);
  report(value === "Skin rash", "Example chip populates the textarea", String(value));
  report((await page.evaluate(() => window.__apiCalls.length)) === 0, "Example click does NOT auto-submit");
  report((await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA", "Focus moves to textarea after example");
}

/* ---- P6: successful analysis → state stored → /results ---- */
console.log("\n== P6 · ANALYZE SUCCESS ==");
{
  await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW, defer: true, analyzeBody: DEFAULT_ANALYSIS });
  await gotoProblem();
  await typeInto(page, "main textarea", "  I have severe tooth pain since yesterday  ");
  await clickButton(page, "Find suitable doctors");
  await sleep(120);
  report((await bodyText()).includes("Understanding your concern…"), 'Loading state "Understanding your concern…"');
  await page.evaluate(() => window.__analyzeResolve());
  await page.waitForFunction(() => location.pathname === "/results", { timeout: 4000 });
  report(true, "Normal urgency navigates to /results");
  const s = await stored();
  report(s.problem === "I have severe tooth pain since yesterday", "Problem stored TRIMMED", s.problem);
  report(s.analysis?.specialization === "Dentist" && s.analysis?.urgency === "normal", "Analysis stored in flow state", s.analysis?.specialization);
  report(s.location?.label === "Lucknow", "Location still intact");
  const calls = await page.evaluate(() => window.__apiCalls);
  report(calls.some((x) => x.includes("/analyze-problem") && x.includes("tooth pain")), "POST /analyze-problem sent with the problem");
  report(calls.filter((x) => x.includes("/analyze-problem")).length === 1, "Exactly one AI call (no duplicates)");
}

/* ---- P7: emergency urgency → emergency screen, no matching ---- */
console.log("\n== P7 · EMERGENCY ==");
{
  await setCfg(page, {
    resetStorage: true,
    seedLocation: LUCKNOW,
    analyzeBody: {
      specialization: "General Physician",
      urgency: "emergency",
      summary: "The description may indicate a medical emergency. Seek immediate emergency medical care.",
      possible_keywords: [],
    },
  });
  await gotoProblem();
  await typeInto(page, "main textarea", "crushing chest pain right now");
  await clickButton(page, "Find suitable doctors");
  await page.waitForFunction(() => document.body.textContent.includes("immediate medical attention"), { timeout: 4000 });
  const t = await bodyText();
  report(true, "Emergency screen shown (backend urgency is source of truth)");
  report(t.includes("Please contact your local emergency number"), "Emergency guidance shown");
  report(t.includes("not for emergencies"), "Discovery-not-for-emergencies boundary stated");
  report(!t.includes("Dentist") && !(await buttonLabels()).includes("Find suitable doctors"), "No doctor recommendations rendered");
  report((await page.evaluate(() => location.pathname)) === "/problem", "Stays on /problem (no /results navigation)");
  await clickButton(page, "Edit description");
  await sleep(150);
  report((await bodyText()).includes("Your symptoms or concern"), '"Edit description" returns to the form');
}

/* ---- P8: API failure → recovery (draft preserved) ---- */
console.log("\n== P8 · FAILURE + RECOVERY ==");
{
  await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW, analyzeStatus: 503 });
  await gotoProblem();
  await typeInto(page, "main textarea", "I have a skin rash");
  await clickButton(page, "Find suitable doctors");
  await page.waitForFunction(() => document.body.textContent.includes("We couldn't analyze that right now."), { timeout: 4000 });
  const t = await bodyText();
  report(true, "HTTP failure → friendly error, no stack traces");
  report(!t.includes("503") && !t.includes("Internal"), "No raw status text leaked");
  report((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Try again", "Focus moves to Try again");
  // Backend "recovers": reconfigure WITHOUT touching storage so the draft
  // survives the reload (setProblem persisted it on every keystroke).
  await setCfg(page, { analyzeStatus: 200, analyzeBody: DEFAULT_ANALYSIS });
  await gotoProblem();
  report((await page.evaluate(() => document.querySelector("main textarea")?.value)) === "I have a skin rash", "Draft preserved through failure + reload");
  await clickButton(page, "Find suitable doctors");
  await page.waitForFunction(() => location.pathname === "/results", { timeout: 4000 });
  report(true, "Retry after recovery reaches /results");
}

/* ---- P9: network failure ---- */
console.log("\n== P9 · NETWORK ==");
{
  await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW, analyzeStatus: 0 });
  await gotoProblem();
  await typeInto(page, "main textarea", "I have a skin rash");
  await clickButton(page, "Find suitable doctors");
  await page.waitForFunction(() => document.body.textContent.includes("We can't reach Mediqo"), { timeout: 4000 });
  report(true, "Network failure → connection-specific message");
}
report(consoleErrors.length === 0, "No console errors in Part A", consoleErrors.join(" | "));

/* ---- P10: change location keeps the problem draft ---- */
console.log("\n== P10 · CHANGE LOCATION ==");
{
  await setCfg(page, { resetStorage: true, seedLocation: LUCKNOW });
  await gotoProblem();
  await typeInto(page, "main textarea", "I have a rash on my arm");
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("main a")].find((a) => a.textContent.trim() === "Change");
    link.click();
  });
  await page.waitForFunction(() => location.pathname === "/location", { timeout: 4000 });
  report(true, '"Change" navigates to /location');
  // Seeded location → /location opens in the success state, which offers
  // "Enter a different city" (not "Enter location manually").
  await clickButton(page, "Enter a different city");
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page, "form input", "Kanpur");
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 4000 });
  await clickButton(page, "Continue");
  await page.waitForFunction(() => location.pathname === "/problem", { timeout: 4000 });
  const t = await bodyText();
  report(t.includes("Location confirmed: Kanpur"), "New location shown on /problem");
  const value = await page.evaluate(() => document.querySelector("main textarea")?.value);
  report(value === "I have a rash on my arm", "Problem draft survived the location change", String(value));
  await clearCfg(page);
}

/* ================================================================
 * PART B — LIVE (real backend AI provider)
 * ================================================================ */
console.log("\n== B · LIVE BACKEND ==");
await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);
const page2 = await browser.newPage();
const consoleErrors2 = [];
page2.on("console", (m) => {
  if (m.type() === "error") consoleErrors2.push(m.text());
});
const analyzeResponses = [];
page2.on("response", (r) => {
  // Count real POSTs only — the first cross-origin call also triggers a
  // CORS preflight OPTIONS that would otherwise inflate the count.
  if (r.url().includes("/analyze-problem") && r.request().method() === "POST") analyzeResponses.push(`${r.status()}`);
});
installMocks(page2);
await setCfg(page2, { resetStorage: true, seedLocation: LUCKNOW, liveAnalyze: true });

const liveCase = async (problem, expect, label) => {
  await page2.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  await sleep(650);
  await typeInto(page2, "main textarea", problem);
  await clickButton(page2, "Find suitable doctors");
  if (expect === "/results") {
    await page2.waitForFunction(() => location.pathname === "/results", { timeout: 10000 });
  } else {
    await page2.waitForFunction(() => document.body.textContent.includes("immediate medical attention"), { timeout: 10000 });
  }
  report(true, label);
};
await liveCase("I have severe tooth pain since yesterday", "/results", "LIVE: tooth pain → /results (offline AI)");
await liveCase("My skin has a rash.", "/results", "LIVE: skin rash → /results");
await liveCase("I have blurry vision.", "/results", "LIVE: blurry vision → /results");
await liveCase("crushing chest pain", "emergency", "LIVE: chest pain → emergency screen (no matching)");
{
  const s = await stored(page2);
  report(s.analysis?.specialization === "General Physician" && s.analysis?.urgency === "emergency", "LIVE: emergency analysis stored", s.analysis?.specialization);
  report(analyzeResponses.length === 4 && analyzeResponses.every((c) => c === "200"), "LIVE: 4 real POST /analyze-problem → 200", analyzeResponses.join(", "));
}
report(consoleErrors2.length === 0, "LIVE: no console errors", consoleErrors2.join(" | "));

/* ================================================================
 * PART C — RESPONSIVE + ACCESSIBILITY
 * ================================================================ */
console.log("\n== C · RESPONSIVE + A11Y ==");
const page3 = await browser.newPage();
installMocks(page3);
await setCfg(page3, { resetStorage: true, seedLocation: LUCKNOW });
for (const width of [320, 375, 390, 768, 1024, 1440]) {
  await page3.setViewport({ width, height: width >= 1024 ? 900 : 820 });
  await page3.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  await sleep(650);
  const r = await page3.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        if (el.closest('[aria-hidden="true"]')) return false;
        const b = el.getBoundingClientRect();
        return b.width > 1 && (b.right > doc.clientWidth + 1 || b.left < -1);
      })
      .slice(0, 3)
      .map((el) => el.tagName);
    const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,span,label,textarea")]
      .filter((el) => {
        if (!el.textContent?.trim() || el.children.length > 0) return false;
        const cs = getComputedStyle(el);
        return cs.overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
      })
      .slice(0, 3)
      .map((el) => el.textContent.trim().slice(0, 24));
    const cta = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Find suitable doctors"));
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      offenders,
      clipped,
      ctaH: cta ? Math.round(cta.getBoundingClientRect().height) : 0,
    };
  });
  report(
    r.overflowX === 0 && r.offenders.length === 0 && r.clipped.length === 0 && r.ctaH >= 44,
    `${width}px clean`,
    r.overflowX !== 0 || r.offenders.length || r.clipped.length ? `overflow=${r.overflowX} off=${r.offenders} clip=${r.clipped}` : `ctaH=${r.ctaH}`,
  );
}

/* axe + keyboard */
await page3.setViewport({ width: 1280, height: 900 });
await page3.goto(BASE + "/problem", { waitUntil: "networkidle0" });
await sleep(650);
await page3.addScriptTag({ content: axeSource });
const axe = await page3.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
report(serious.length === 0, "axe: no serious violations", serious.map((v) => `${v.id}(${v.nodes.length})`).join(", "));

const stops = [];
for (let i = 0; i < 16; i++) {
  // 16 tabs: the desktop header alone consumes ~5 stops before main content.
  await page3.keyboard.press("Tab");
  const s = await page3.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName,
      label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24),
      fv: el.matches(":focus-visible"),
      outline: getComputedStyle(el).outlineWidth,
    };
  });
  if (s) stops.push(s);
}
report(stops.some((s) => s.tag === "TEXTAREA"), "Textarea keyboard-reachable");
report(stops.some((s) => s.label.includes("Find suitable doctors")), "Submit CTA keyboard-reachable");
report(stops.some((s) => s.label.includes("Tooth pain")), "Example chips keyboard-reachable");
report(stops.every((s) => s.fv && parseFloat(s.outline) >= 1), "Focus-visible ring on every stop");

/* reduced motion: loading message still informative, loops stopped */
{
  await page3.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await setCfg(page3, { resetStorage: true, seedLocation: LUCKNOW, defer: true });
  await page3.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  await sleep(600);
  await typeInto(page3, "main textarea", "I have severe tooth pain");
  await clickButton(page3, "Find suitable doctors");
  await sleep(250);
  const t = await bodyText(page3);
  report(t.includes("Understanding your concern…"), "Reduced motion: loading message shows");
  report(!t.includes("Finding the right medical specialty…"), "Reduced motion: secondary line suppressed");
  const loops = await page3.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running" && getComputedStyle(a.effect?.target ?? document.body).animationIterationCount === "infinite").length,
  );
  report(loops === 0, "Reduced motion: no looping animations", String(loops));
  await page3.emulateMediaFeatures([]);
}

await browser.close();
console.log(`\n===== PROBLEM QA: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
