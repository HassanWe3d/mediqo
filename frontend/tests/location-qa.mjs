/**
 * Mediqo location-experience QA harness (Step 9.3 verification).
 *
 * Part A — deterministic: mocks navigator.geolocation (success/denied/
 *   unavailable/timeout/unsupported) and intercepts backend calls, so
 *   every spec scenario runs without real permissions or a flaky API.
 *   The geo fix is resolved manually (window.__geoResolve) so loading
 *   states are asserted without timing races.
 * Part B — live: grants REAL geolocation permission, feeds REAL browser
 *   GPS via CDP emulation, and hits the REAL FastAPI backend.
 *
 * Run from frontend/:  node tests/location-qa.mjs
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

/* ================================================================
 * PART A — DETERMINISTIC (mocked geolocation + fetched network)
 * ================================================================ */
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

/** Install mocks before any app code runs, parameterized per scenario. */
const armMocks = async (pg, { geoOutcome, validateStatus = 200, manualFailure = null }) => {
  await pg.evaluateOnNewDocument(
    ({ geoOutcome, validateStatus, manualFailure }) => {
      const realFetch = window.fetch.bind(window);
      const reply = (status, body) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      // ---- geolocation mock: resolved manually via __geoResolve() ----
      // evaluateOnNewDocument scripts ACCUMULATE across armMocks() calls;
      // clear both the prototype and any instance property so the most
      // recently armed scenario always wins.
      delete Navigator.prototype.geolocation;
      delete navigator.geolocation;
      if (geoOutcome !== "unsupported") {
        const geo = {
          getCurrentPosition: (success, error) => {
            window.__geoCalls = (window.__geoCalls ?? 0) + 1;
            window.__geoResolve = () => {
              if (geoOutcome === "success")
                success({ coords: { latitude: 26.8902, longitude: 80.9602, accuracy: 30.2 } });
              else if (geoOutcome === "denied") error({ code: 1, message: "denied" });
              else if (geoOutcome === "unavailable") error({ code: 2, message: "unavailable" });
              else error({ code: 3, message: "timeout" });
            };
          },
        };
        Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
      }

      // ---- network mock (API-level interception) ----
      window.__apiCalls = [];
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const body = init?.body ? JSON.parse(init.body) : null;
        window.__apiCalls.push(`${init?.method ?? "GET"} ${url} ${body ? JSON.stringify(body) : ""}`);
        if (url.includes("/location/validate")) {
          return validateStatus === 200
            ? reply(200, { valid: true, latitude: 26.8902, longitude: 80.9602 })
            : reply(503, { detail: "Mediqo is temporarily unavailable. Please try again shortly." });
        }
        if (url.includes("/location/manual")) {
          if (manualFailure === "network") throw new TypeError("Failed to fetch"); // true network failure
          if (body.city.trim().toLowerCase() === "lucknow")
            return reply(200, { valid: true, city: "Lucknow", latitude: 26.8467, longitude: 80.9462 });
          return reply(400, { detail: "This location is not currently supported." });
        }
        return realFetch(input, init);
      };
    },
    { geoOutcome, validateStatus, manualFailure },
  );
};

const gotoLocation = async () => {
  await page.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await page.evaluate(() => sessionStorage.clear()); // scenario isolation
  await page.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(800); // entrance animations settle
};
const calls = () => page.evaluate(() => window.__apiCalls ?? []);
const resolveGeo = (pg = page) => pg.evaluate(() => window.__geoResolve());
const bodyText = () => page.evaluate(() => document.body.textContent);
const buttonLabels = () =>
  page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()));
/** puppeteer-core has no :has-text() — find by normalized text and JS-click. */
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
    // Clear any pre-existing value (the manual panel keeps the last city)
    // through the native setter so React's onChange sees the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }, selector);
  await pg.keyboard.type(text, { delay: 4 });
};

/* ---- A1: renders, no API on load (spec #1, #2, #12) ---- */
console.log("\n== A1 · RENDER ==");
await armMocks(page, { geoOutcome: "success" });
await gotoLocation();
{
  report((await page.evaluate(() => location.pathname)) === "/location", "Opens at /location");
  const t = await bodyText();
  const c = await calls();
  report(t.includes("MEDIQO."), "Wordmark renders");
  report(t.includes("Where are you?"), "Heading renders");
  report(t.includes("Allow Mediqo to use your location"), "Supporting copy renders");
  report((await buttonLabels()).includes("Allow Location"), '"Allow Location" button renders');
  report(t.includes("Enter location manually"), '"Enter location manually" secondary renders');
  report(t.includes("Step 1 of 3") && t.includes("Back"), "Step eyebrow + back navigation render");
  report(c.length === 0, "No API calls on page load", c.join(" | "));
}

/* ---- A2: geo success → backend validate → success panel (spec #3, #6, #13) ---- */
console.log("\n== A2 · GEO SUCCESS ==");
{
  await clickButton(page, "Allow Location");
  await sleep(120);
  report((await bodyText()).includes("Finding your location…"), 'Loading state "Finding your location…"');
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 4000 });
  const c = await calls();
  report(c.length === 1 && c[0].includes("/location/validate") && c[0].includes("26.8902"), "POST /location/validate with coords", c[0]);
  report(!(await bodyText()).includes("26.8902"), "Precise coordinates NOT exposed in UI");
  report((await bodyText()).includes("Your current location"), "Friendly location label shown");
  report((await buttonLabels()).includes("Continue"), '"Continue" CTA appears');
  report((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Continue", "Focus moves to Continue");
  report((await bodyText()).includes("never stored permanently"), "Privacy microcopy shown");
}

/* ---- A2b: Continue → /problem, SPA state preserved (spec #10, #11) ---- */
{
  await page.evaluate(() => { window.__qa_marker = "alive"; });
  await clickButton(page, "Continue");
  await page.waitForFunction(() => location.pathname === "/problem", { timeout: 4000 });
  report(true, "Continue navigates to /problem");
  report((await page.evaluate(() => window.__qa_marker)) === "alive", "SPA navigation (no reload)");
  const t = await bodyText();
  report(t.includes("Location confirmed") && t.includes("Your current location"), "Flow state visible on /problem");
  const stored = JSON.parse((await page.evaluate(() => sessionStorage.getItem("mediqo.flow.location"))) ?? "{}");
  report(stored.method === "browser" && stored.latitude === 26.8902, "Coordinates preserved in session state", stored.method);
}

/* ---- A2c: survives reload (session-only persistence) ---- */
{
  await page.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  report((await bodyText()).includes("Location confirmed"), "Location survives a page reload (session)");
}

/* ---- A3: permission denied (spec #8) ---- */
console.log("\n== A3 · DENIED ==");
await armMocks(page, { geoOutcome: "denied" });
await gotoLocation();
{
  await clickButton(page, "Allow Location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("Location access was denied."), { timeout: 4000 });
  const t = await bodyText();
  report(t.includes("You can enter your city manually instead."), "Denied guidance shown");
  report((await buttonLabels()).includes("Enter location manually"), "Manual fallback offered (no trap)");
}

/* ---- A4: unavailable + retry (spec #5, #15) ---- */
console.log("\n== A4 · UNAVAILABLE + RETRY ==");
{
  await armMocks(page, { geoOutcome: "unavailable" });
  await gotoLocation();
  await clickButton(page, "Allow Location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("We couldn't determine your location."), { timeout: 4000 });
  report((await bodyText()).includes("Try again, or enter your city manually."), "Unavailable copy shown");
  report((await buttonLabels()).includes("Try again"), '"Try again" offered');
  const before = await page.evaluate(() => window.__geoCalls);
  await clickButton(page, "Try again");
  await sleep(200);
  const after = await page.evaluate(() => window.__geoCalls);
  report(after === before + 1, "Retry re-runs the geolocation request (no page refresh)", `${before}→${after}`);
}

/* ---- A5: timeout maps to friendly failure (spec #10) ---- */
{
  await armMocks(page, { geoOutcome: "timeout" });
  await gotoLocation();
  await clickButton(page, "Allow Location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("We couldn't determine your location."), { timeout: 4000 });
  report(true, "Timeout maps to the same friendly failure");
}

/* ---- A6: geolocation unsupported (spec #10) ---- */
{
  await armMocks(page, { geoOutcome: "unsupported" });
  await gotoLocation();
  await clickButton(page, "Allow Location");
  await page.waitForFunction(() => document.body.textContent.includes("Location services are not available"), { timeout: 4000 });
  report((await bodyText()).includes("You can enter your city manually instead."), "Unsupported-browser copy + fallback offered");
}

/* ---- A7: backend validation failure (spec #7, #10) ---- */
console.log("\n== A7 · BACKEND FAILURE ==");
{
  await armMocks(page, { geoOutcome: "success", validateStatus: 503 });
  await gotoLocation();
  await clickButton(page, "Allow Location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("We couldn't verify your location."), { timeout: 4000 });
  const t = await bodyText();
  report(t.includes("Mediqo is temporarily unavailable"), "Clean backend-error message");
  report(!t.includes("503") && !t.includes("POST"), "No raw status/method leaked");
  await clickButton(page, "Try again");
  await sleep(250);
  report((await bodyText()).includes("We couldn't verify your location."), "Retry re-runs after backend failure");
}

/* ---- A8: manual fallback success (spec #8, #9) ---- */
console.log("\n== A8 · MANUAL FALLBACK ==");
{
  await armMocks(page, { geoOutcome: "success" });
  await gotoLocation();
  await clickButton(page, "Enter location manually");
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  report((await page.evaluate(() => document.activeElement?.tagName)) === "INPUT", "City input auto-focused");
  report((await page.evaluate(() => document.querySelector("form label")?.textContent.trim())) === "City", "Input has a proper label");
  await typeInto(page, "form input", "Lucknow");
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 4000 });
  report((await calls()).some((x) => x.includes("/location/manual") && x.includes("Lucknow")), "POST /location/manual called");
  report((await bodyText()).includes("Lucknow"), "City label shown");
  const stored = JSON.parse((await page.evaluate(() => sessionStorage.getItem("mediqo.flow.location"))) ?? "{}");
  report(stored.method === "city" && stored.label === "Lucknow", "City stored with backend-provided centre", stored.label);

  /* ---- A8b: switch city → browser detection, then whitespace trim ---- */
  await clickButton(page, "Use my current location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("Your current location"), { timeout: 4000 });
  report(true, "Switch: manual city → automatic detection works");
  await clickButton(page, "Enter a different city");
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page, "form input", "  lucknow  ");
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 4000 });
  // The app trims whitespace CLIENT-SIDE (city.trim() before the API call):
  report((await calls()).some((x) => x.includes('"city":"lucknow"')), "Client trims whitespace before sending");
  report((await bodyText()).includes("Lucknow"), "…backend canonical 'Lucknow' displayed");
}

/* ---- A9: unsupported + empty city (spec #9, #10) ---- */
console.log("\n== A9 · UNSUPPORTED / EMPTY CITY ==");
{
  // Reach the browser-method success state first — only it offers
  // "Enter a different city" (city-method offers "Use my current location").
  await clickButton(page, "Use my current location");
  await resolveGeo();
  await page.waitForFunction(() => document.body.textContent.includes("Your current location"), { timeout: 4000 });
  await clickButton(page, "Enter a different city");
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page, "form input", "Mumbai");
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("not currently supported"), { timeout: 4000 });
  report(true, "Unsupported city → clean inline error");
  report((await page.evaluate(() => document.querySelector("form input")?.getAttribute("aria-invalid"))) === "true", "Error announced via aria-invalid");
  await page.evaluate(() => {
    const i = document.querySelector("form input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(i, "");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("Please enter a city."), { timeout: 4000 });
  report(true, "Empty city rejected inline");
}

/* ---- A10: network failure on manual submit (spec #10) ---- */
console.log("\n== A10 · NETWORK FAILURE ==");
{
  await armMocks(page, { geoOutcome: "success", manualFailure: "network" });
  await gotoLocation();
  await clickButton(page, "Enter location manually");
  await page.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page, "form input", "Lucknow");
  await clickButton(page, "Continue");
  await page.waitForFunction(() => document.body.textContent.includes("can't reach Mediqo"), { timeout: 4000 });
  report(true, "Network failure → friendly message, form survives");
}

/* ---- A11: guards & cross-page state (spec #11) ---- */
console.log("\n== A11 · GUARDS ==");
{
  // Step 9.5 replaced the /results placeholder with the real page, which
  // guards against missing flow state — empty storage must bounce to /location.
  await page.goto(BASE + "/results", { waitUntil: "networkidle0" });
  report((await page.evaluate(() => location.pathname)) === "/location", "Direct /results without flow state redirects to /location");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "mediqo.flow.location",
      JSON.stringify({ method: "city", label: "Lucknow", latitude: 26.8467, longitude: 80.9462 }),
    ),
  );
  await page.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  report((await bodyText()).includes("Location confirmed"), "State survives navigation across pages");
}
report(consoleErrors.length === 0, "No console errors in Part A", consoleErrors.join(" | "));

/* ================================================================
 * PART B — LIVE (real permission + real GPS + real backend)
 * ================================================================ */
console.log("\n== B · LIVE PERMISSION + REAL BACKEND ==");
await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);

const page2 = await browser.newPage();
const consoleErrors2 = [];
page2.on("console", (m) => {
  if (m.type() === "error") consoleErrors2.push(m.text());
});
const liveCalls = [];
page2.on("response", (r) => {
  if (r.url().includes(":8000")) liveCalls.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
});
const cdp = await page2.createCDPSession();
await cdp.send("Emulation.setGeolocationOverride", { latitude: 26.8467, longitude: 80.9462, accuracy: 25 });

await page2.goto(BASE + "/location", { waitUntil: "networkidle0" });
await sleep(800);
{
  await clickButton(page2, "Allow Location");
  await page2.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 8000 });
  report(true, "LIVE: real permission + GPS → Location detected");
  const v = liveCalls.find((x) => x.includes("/location/validate"));
  report(v?.startsWith("200"), "LIVE: real POST /location/validate → 200", v);
  report(!(await page2.evaluate(() => document.body.textContent)).includes("26.8467"), "LIVE: coordinates not exposed in UI");
}
{
  await clickButton(page2, "Continue");
  await page2.waitForFunction(() => location.pathname === "/problem", { timeout: 5000 });
  report(true, "LIVE: Continue → /problem");
  report((await page2.evaluate(() => document.body.textContent)).includes("Location confirmed"), "LIVE: /problem confirms flow state");
}

/* Live manual path (no GPS needed) */
const page3 = await browser.newPage();
const liveCalls3 = [];
page3.on("response", (r) => {
  if (r.url().includes(":8000")) liveCalls3.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
});
await page3.goto(BASE + "/location", { waitUntil: "networkidle0" });
await sleep(800);
{
  await clickButton(page3, "Enter location manually");
  await page3.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page3, "form input", "Lucknow");
  await clickButton(page3, "Continue");
  await page3.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 5000 });
  const m = liveCalls3.find((x) => x.includes("/location/manual"));
  report(m?.startsWith("200"), "LIVE: real POST /location/manual (Lucknow) → 200", m);
  report((await page3.evaluate(() => document.body.textContent)).includes("Lucknow"), "LIVE: canonical city label shown");
}
{
  /* Live unsupported city on a fresh idle panel */
  await page3.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await page3.evaluate(() => sessionStorage.clear());
  await page3.reload({ waitUntil: "networkidle0" });
  await sleep(700);
  await clickButton(page3, "Enter location manually");
  await page3.waitForFunction(() => document.body.textContent.includes("Enter your city"), { timeout: 4000 });
  await typeInto(page3, "form input", "Atlantis");
  await clickButton(page3, "Continue");
  await page3.waitForFunction(() => document.body.textContent.includes("not currently supported"), { timeout: 5000 });
  report(true, "LIVE: Atlantis → clean unsupported-city error (real backend)");
}
report(consoleErrors2.length === 0, "LIVE: no console errors", consoleErrors2.join(" | "));

/* ================================================================
 * PART C — RESPONSIVE + ACCESSIBILITY (/location)
 * ================================================================ */
console.log("\n== C · RESPONSIVE + A11Y ==");
const page4 = await browser.newPage();
for (const width of [320, 375, 390, 768, 1024, 1440]) {
  await page4.setViewport({ width, height: width >= 1024 ? 900 : 780 });
  await page4.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(650);
  const r = await page4.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        if (el.closest('[aria-hidden="true"]')) return false;
        const b = el.getBoundingClientRect();
        return b.width > 1 && (b.right > doc.clientWidth + 1 || b.left < -1);
      })
      .slice(0, 3)
      .map((el) => el.tagName);
    const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,span,label")]
      .filter((el) => {
        if (!el.textContent.trim() || el.children.length > 0) return false;
        const cs = getComputedStyle(el);
        return cs.overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
      })
      .slice(0, 3)
      .map((el) => el.textContent.trim().slice(0, 24));
    const cta = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Allow Location"));
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

/* No backend calls while idling on /location */
{
  const n = await page4.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes(":8000")).length);
  report(n === 0, "No backend calls on /location load", String(n));
}

/* axe on the manual panel (a11y-critical state) */
await page4.setViewport({ width: 1280, height: 900 });
await page4.goto(BASE + "/location", { waitUntil: "networkidle0" });
await sleep(700);  await clickButton(page4, "Enter location manually");
await page4.waitForFunction(() => document.body.textContent.includes("Enter your city"));
await page4.addScriptTag({ content: axeSource });
const axe = await page4.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
report(serious.length === 0, "axe (manual panel): no serious violations", serious.map((v) => `${v.id}(${v.nodes.length})`).join(", "));

/* keyboard traversal on the idle panel */
await page4.goto(BASE + "/location", { waitUntil: "networkidle0" });
await sleep(600);
const stops = [];
for (let i = 0; i < 8; i++) {
  await page4.keyboard.press("Tab");
  const s = await page4.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24),
      fv: el.matches(":focus-visible"),
      outline: getComputedStyle(el).outlineWidth,
    };
  });
  if (s) stops.push(s);
}
report(stops.length >= 3, "Keyboard reaches 3+ stops", String(stops.length));
report(stops.every((s) => s.fv && parseFloat(s.outline) >= 1), "Focus-visible ring on every stop");
report(stops.some((s) => s.label.includes("Allow Location")), "Allow Location reachable by keyboard");
report(stops.some((s) => s.label.includes("Enter location manually")), "Manual fallback reachable by keyboard");

/* reduced motion: driven by the deterministic mock (geolocation is orthogonal
   to what's being tested here — loops stop, content visible, flow intact) */
await page2.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await armMocks(page2, { geoOutcome: "success" });
await page2.goto(BASE + "/location", { waitUntil: "networkidle0" });
await page2.evaluate(() => sessionStorage.clear());
await page2.reload({ waitUntil: "networkidle0" });
await sleep(500);
{
  await clickButton(page2, "Allow Location");
  await resolveGeo(page2);
  await page2.waitForFunction(() => document.body.textContent.includes("Location detected"), { timeout: 8000 });
  const rm = await page2.evaluate(() => ({
    h1Visible: parseFloat(getComputedStyle(document.querySelector("main h1")).opacity) === 1,
    loops: document.getAnimations().filter((a) => a.playState === "running" && getComputedStyle(a.effect?.target ?? document.body).animationIterationCount === "infinite").length,
  }));
  report(rm.h1Visible, "Reduced motion: content fully visible");
  report(rm.loops === 0, "Reduced motion: no looping animations", String(rm.loops));
}
await page2.emulateMediaFeatures([]);

await browser.close();
console.log(`\n===== LOCATION QA: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
