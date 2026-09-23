/**
 * Mediqo cross-page design + consistency QA (Step 9.7).
 *
 * Audits all five screens with REAL backend data (session state is seeded
 * from live API responses — no mocks):
 *   - 7-viewport mobile sweep (320–1920): overflow, clipping, tap targets
 *   - axe accessibility per page (consolidated)
 *   - design-system metrics: radius/shadow/type tokens per page
 *   - results-page conformance: order/scores/distances/reasons must equal
 *     the live POST /match-doctors response (backend is source of truth)
 *
 * Run from frontend/:  node tests/design-qa.mjs   (backend must be up)
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:8000";
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

/* Real match data for the results/profile seeding. */
const matchResponse = await fetch(`${API}/match-doctors`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ latitude: 26.8467, longitude: 80.9462, problem: "I have severe tooth pain since yesterday" }),
}).then((r) => r.json());
if (matchResponse.status !== "success" || matchResponse.results.length === 0) {
  console.error("Backend did not return a usable match response — aborting design QA");
  process.exit(1);
}
const topId = matchResponse.results[0].doctor.id;

const seedRealFlow = (pg) =>
  pg.evaluate(
    ({ match }) => {
      sessionStorage.clear();
      sessionStorage.setItem("mediqo.flow.location", JSON.stringify({ method: "city", label: "Lucknow", latitude: 26.8467, longitude: 80.9462 }));
      sessionStorage.setItem("mediqo.flow.problem", "I have severe tooth pain since yesterday");
      sessionStorage.setItem("mediqo.flow.analysis", JSON.stringify(match.analysis));
      sessionStorage.setItem("mediqo.flow.match", JSON.stringify(match));
    },
    { match: matchResponse },
  );

const PAGES = [
  /* Two-tier type system (intentional design): the landing hero is the
     marketing display size (48–60px); every product/flow page uses the
     product band (28–44px). */
  { name: "landing", url: "/", setup: null, h1Band: [48, 60] },
  { name: "location", url: "/location", setup: null, h1Band: [28, 44] },
  { name: "problem", url: "/problem", setup: "seedLocation", h1Band: [28, 44] },
  { name: "results", url: "/results", setup: "seedFull", h1Band: [28, 44] },
  { name: "profile", url: `/doctor/${topId}`, setup: "seedFull", h1Band: [28, 44] },
];

const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const WIDTHS = [320, 375, 390, 768, 1024, 1440, 1920];
for (const { name, url, setup } of PAGES) {
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: width >= 1024 ? 900 : 820 });
    await page.goto(BASE + url, { waitUntil: "networkidle0" });
    if (setup) {
      // Seed AFTER the first load so the SPA picks it up on reload.
      await seedRealFlow(page);
      await page.reload({ waitUntil: "networkidle0" });
    }
    if (setup === "seedLocation") {
      // problem page needs location only; keep analysis absent.
      await page.evaluate(() => sessionStorage.removeItem("mediqo.flow.analysis"));
      await page.evaluate(() => sessionStorage.removeItem("mediqo.flow.match"));
      await page.reload({ waitUntil: "networkidle0" });
    }
    await sleep(650);

    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const offenders = [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.closest('[aria-hidden="true"]')) return false;
          const b = el.getBoundingClientRect();
          return b.width > 1 && (b.right > doc.clientWidth + 1 || b.left < -1);
        })
        .slice(0, 3)
        .map((el) => el.tagName);
      const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,span,label,dd")]
        .filter((el) => {
          if (!el.textContent?.trim() || el.children.length > 0) return false;
          if (el.closest(".sr-only") || getComputedStyle(el).position === "absolute") return false;
          const cs = getComputedStyle(el);
          return cs.overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
        })
        .slice(0, 3)
        .map((el) => el.textContent.trim().slice(0, 24));
      const cta = [...document.querySelectorAll("main button, main a")].find((el) => {
        const t = el.textContent.trim();
        return /Find a Doctor|Find suitable doctors|Allow Location|Continue|View Profile/.test(t);
      });
      return {
        overflowX: doc.scrollWidth - doc.clientWidth,
        offenders,
        clipped,
        ctaH: cta ? Math.round(cta.getBoundingClientRect().height) : null,
      };
    });
    const ctaOk = r.ctaH === null || r.ctaH >= 44;
    report(
      r.overflowX === 0 && r.offenders.length === 0 && r.clipped.length === 0 && ctaOk,
      `${name} @ ${width}px`,
      r.overflowX !== 0 || r.offenders.length || r.clipped.length || !ctaOk
        ? `overflow=${r.overflowX} off=${r.offenders} clip=${r.clipped} cta=${r.ctaH}`
        : `cta=${r.ctaH}px`,
    );
  }
}

/* ---- Design-system metrics per page (1280px) ---- */
console.log("\n== DESIGN METRICS @1280 ==");
await page.setViewport({ width: 1280, height: 900 });
const TOKEN_RADII = new Set(["10px", "14px", "16px", "20px", "24px", "9999px"]);
for (const { name, url, setup } of PAGES) {
  await page.goto(BASE + url, { waitUntil: "networkidle0" });
  if (setup) {
    await seedRealFlow(page);
    await page.reload({ waitUntil: "networkidle0" });
    if (setup === "seedLocation") {
      await page.evaluate(() => { sessionStorage.removeItem("mediqo.flow.analysis"); sessionStorage.removeItem("mediqo.flow.match"); });
      await page.reload({ waitUntil: "networkidle0" });
    }
  }
  await sleep(650);
  const m = await page.evaluate(() => {
    /* Inline token scale — module-scope constants do not exist inside
       puppeteer-serialized evaluate callbacks. */
    const TOKEN_RADII = new Set(["10px", "14px", "16px", "20px", "24px", "9999px"]);
    const offRadii = new Set();
    let soft = 0;
    let heavy = 0;
    const fontSizes = new Set();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      const r = cs.borderRadius;
      if (r && r !== "0px" && !TOKEN_RADII.has(r)) offRadii.add(r);
      const shadows = cs.boxShadow;
      if (shadows && shadows !== "none") {
        if (/rgba\((?:\d+\s*,\s*){3}\s*(?:0\.\d+\)|1\)|0\))/.test(shadows) || shadows.includes("rgba(22, 33, 28")) soft++;
        else heavy++;
      }
      const fs = cs.fontSize;
      if (el.children.length === 0 && fs) fontSizes.add(fs);
    }
    const h1 = document.querySelector("h1");
    return {
      offRadii: [...offRadii].slice(0, 4),
      soft,
      heavy,
      h1: h1 ? getComputedStyle(h1).fontSize : null,
      distinctFontSizes: fontSizes.size,
    };
  });
  report(m.offRadii.length === 0, `${name}: radii only from the token scale`, m.offRadii.join(", ") || "clean");
  report(m.heavy === 0, `${name}: only soft token shadows`, `soft=${m.soft} heavy=${m.heavy}`);
  const pageCfg = PAGES.find((p) => p.name === name);
  const [minH1, maxH1] = pageCfg?.h1Band ?? [28, 44];
  report(
    m.h1 !== null && Number.parseFloat(m.h1) >= minH1 && Number.parseFloat(m.h1) <= maxH1,
    `${name}: H1 in its type band (${minH1}–${maxH1}px)`,
    m.h1 ?? "none",
  );
}

/* ---- axe per page ---- */
console.log("\n== ACCESSIBILITY (axe, per page) ==");
for (const { name, url, setup } of PAGES) {
  await page.goto(BASE + url, { waitUntil: "networkidle0" });
  if (setup) {
    await seedRealFlow(page);
    await page.reload({ waitUntil: "networkidle0" });
    if (setup === "seedLocation") {
      await page.evaluate(() => { sessionStorage.removeItem("mediqo.flow.analysis"); sessionStorage.removeItem("mediqo.flow.match"); });
      await page.reload({ waitUntil: "networkidle0" });
    }
  }
  await sleep(650);
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
  const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  report(serious.length === 0, `${name}: axe 0 serious violations`, serious.map((v) => `${v.id}(${v.nodes.length})`).join(", ") || "clean");
}

/* ---- Results-page conformance: backend is the single source of truth ---- */
console.log("\n== RESULTS CONFORMANCE (real API) ==");
{
  await page.goto(BASE + "/results", { waitUntil: "networkidle0" });
  await seedRealFlow(page);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll("[data-match-score]").length >= 1, { timeout: 20000 });
  await sleep(400);
  const ui = await page.evaluate(() => ({
    scores: [...document.querySelectorAll("[data-match-score]")].map((el) => Number.parseInt(el.textContent, 10)),
    distances: [...document.querySelectorAll("main li")]
      .filter((li) => li.querySelector("h3"))
      .map((li) => li.textContent.match(/(\d+\.\d) km away/)?.[1] ?? null),
    reasons: [...document.querySelectorAll("main li")]
      .filter((li) => li.querySelector("h3"))
      .map((li) => [...li.querySelectorAll("ul li")].map((x) => x.textContent.trim())),
  }));
  const apiScores = matchResponse.results.map((r) => r.match_score);
  const apiDists = matchResponse.results.map((r) => r.distance_km.toFixed(1));
  report(
    ui.scores.length === apiScores.length && ui.scores.every((s, i) => s === apiScores[i]),
    "Rendered match scores equal the API values in API order",
    `UI=[${ui.scores}] API=[${apiScores}]`,
  );
  report(
    ui.distances.length === apiDists.length && ui.distances.every((d, i) => d === apiDists[i]),
    "Rendered distances equal the API values (1dp)",
    `UI=[${ui.distances}] API=[${apiDists}]`,
  );
  report(
    ui.reasons.every((list, i) => list.every((reason) => matchResponse.results[i].match_reasons.includes(reason))),
    "Every displayed reason exists verbatim in the API match_reasons",
  );
}
report(consoleErrors.length === 0, "Design QA: no console errors across all pages", consoleErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n===== DESIGN QA: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
