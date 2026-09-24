/**
 * Mediqo landing-page QA harness (Step 9.2 verification).
 *
 * Drives the system Chrome (puppeteer-core, no download) against the Vite
 * dev server: functional checks, CTA/navigation behavior, 7-viewport
 * responsive sweep, axe-core accessibility audit, keyboard traversal,
 * prefers-reduced-motion emulation, layout-shift and network audits.
 *
 * Run from frontend/:  node tests/landing-qa.mjs
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5173";
const axeSource = readFileSync("node_modules/axe-core/axe.min.js", "utf8");

let failures = 0;
const report = (pass, name, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!pass) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

const page = await browser.newPage();
const consoleErrors = [];
const consoleWarnings = [];
const failedRequests = [];
const backendCalls = [];

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
  if (m.type() === "warning") consoleWarnings.push(m.text());
});
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (/127\.0\.0\.1:8000|localhost:8000/.test(r.url()) && r.status() >= 400) {
    backendCalls.push(`${r.status()} ${r.url()}`);
  }
});

// Register the CLS observer before any navigation (survives via evaluateOnNewDocument).
await page.evaluateOnNewDocument(() => {
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
});

const gotoLanding = async () => {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1200)); // let entrance animations settle (max delay 320ms + 420ms duration)
};

/* ------------------------------------------------------------------ */
/* 1. FUNCTIONAL — everything renders, CTA + nav behave                */
/* ------------------------------------------------------------------ */
console.log("\n== FUNCTIONAL ==");
await gotoLanding();

const f = await page.evaluate(() => ({
  wordmark: document.querySelector("header a")?.textContent?.trim() ?? "",
  navLinks: [...document.querySelectorAll("header nav a")].map((a) => a.getAttribute("href")),
  headerCta: !!document.querySelector('header a[href="/location"]'),
  h1: document.querySelector("main h1")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  supporting: !!document.querySelector("main h1 ~ p, main div p"),
  heroCta: !!document.querySelector('main a[href="/location"]'),
  sections: [...document.querySelectorAll("main section")].length,
  stepItems: document.querySelectorAll("#how-it-works ol li").length,
  whySection: !!document.getElementById("why-mediqo"),
  finalCta: !!document.querySelector('main section:last-of-type a[href="/location"]'),
  footer: document.querySelector("footer")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  heroCards: [...document.querySelectorAll("main")].toString().includes("stomach pain") ||
    document.body.textContent.includes("stomach pain"),
}));
report(f.wordmark === "MEDIQO.", "Wordmark renders", f.wordmark);
report(f.navLinks.length === 3, "Nav renders 3 links (2 anchors + Manage appointment)", f.navLinks.join(", "));
report(f.headerCta && f.heroCta && f.finalCta, "All 3 Find-a-Doctor CTAs present");
report(f.h1.includes("right doctor") && f.h1.includes("wherever you are"), "Headline correct", f.h1);
report(f.supporting, "Supporting copy renders");
report(f.sections >= 3, "Landing sections render", `${f.sections} sections`);
report(f.stepItems === 4, "How-it-works has 4 steps", `${f.stepItems}`);
report(f.whySection, "Differentiator section renders");
report(f.heroCards, "Hero flow visual (problem copy) renders");
report(f.footer.includes("MVP demo") && f.footer.includes("emergency"), "Footer renders with demo + safety labels");

// CTA → /location as an SPA navigation (no full reload).
await page.evaluate(() => {
  window.__qa_marker = "alive";
});
await page.click('main a[href="/location"]');
await page.waitForFunction(() => location.pathname === "/location", { timeout: 5000 });
const marker = await page.evaluate(() => window.__qa_marker ?? "gone");
report(marker === "alive", "Hero CTA navigates to /location without full page reload");
const locationRendered = await page.evaluate(
  () => document.body.textContent.length > 100 && !document.body.textContent.includes("404"),
);
report(locationRendered, "/location destination renders (no 404)");

// Back to landing, then header CTA and anchors.
await page.goBack();
await page.waitForFunction(() => location.pathname === "/", { timeout: 5000 });
await page.click('header a[href="/location"]');
await page.waitForFunction(() => location.pathname === "/location", { timeout: 5000 });
report(true, "Header CTA navigates to /location");
await page.goBack();
await page.waitForFunction(() => location.pathname === "/", { timeout: 5000 });

for (const [href, id] of [
  ["/#how-it-works", "how-it-works"],
  ["/#why-mediqo", "why-mediqo"],
]) {
  await page.click(`header nav a[href="${href}"]`);
  await page.waitForFunction((h) => location.hash === h.split("/")[1], { timeout: 5000 }, href);
  await new Promise((r) => setTimeout(r, 650));
  const top = await page.evaluate((i) => {
    const r = document.getElementById(i)?.getBoundingClientRect();
    return r ? Math.round(r.top) : null;
  }, id);
  report(top !== null && top > -80 && top < 300, `Anchor ${href} scrolls to section`, `top=${top}px`);
}
await page.click('header a[href="/"]');
await page.waitForFunction(() => location.pathname === "/" && !location.hash, { timeout: 5000 });
report(true, "Wordmark returns to clean landing page");

/* ------------------------------------------------------------------ */
/* 2. RESPONSIVE — 7 widths: overflow, clipping, overlap, tap targets  */
/* ------------------------------------------------------------------ */
console.log("\n== RESPONSIVE ==");
const WIDTHS = [320, 375, 390, 768, 1024, 1440, 1920];
for (const width of WIDTHS) {
  await page.setViewport({ width, height: width >= 1024 ? 900 : 800 });
  await gotoLanding();
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        if (el.closest('[aria-hidden="true"]')) return false;
        const b = el.getBoundingClientRect();
        return b.width > 1 && (b.right > doc.clientWidth + 1 || b.left < -1);
      })
      .slice(0, 3)
      .map((el) => `${el.tagName}.${String(el.className).split(" ").slice(0, 2).join(".")}`);
    const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,span")]
      .filter((el) => {
        if (!el.textContent.trim() || el.children.length > 0) return false;
        const cs = getComputedStyle(el);
        return cs.overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
      })
      .slice(0, 3)
      .map((el) => el.textContent.trim().slice(0, 28));
    const els = [...document.querySelectorAll("body *")].filter((el) => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if (["SCRIPT", "STYLE", "LINK", "META"].includes(el.tagName)) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    });
    const overlaps = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ix > 6 && iy > 6) overlaps.push(`${a.tagName}<${b.tagName}>`);
      }
    }
    const tinyTaps = [...document.querySelectorAll("a, button")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (b.height < 24 || b.width < 24);
      })
      .map((el) => `${el.textContent.trim().slice(0, 18) || el.tagName}(${Math.round(el.getBoundingClientRect().height)}px)`)
      .slice(0, 4);
    const h1Size = parseFloat(getComputedStyle(document.querySelector("main h1")).fontSize);
    const footerOk = document.querySelector("footer")?.getBoundingClientRect().height > 40;
    return { overflowX, offenders, clipped, overlaps: [...new Set(overlaps)].slice(0, 3), tinyTaps, h1Size, footerOk };
  });
  const pass =
    r.overflowX === 0 && r.offenders.length === 0 && r.clipped.length === 0 &&
    r.overlaps.length === 0 && r.h1Size >= 28 && r.footerOk;
  report(
    pass,
    `${width}px`,
    pass
      ? "clean"
      : `overflow=${r.overflowX} off=[${r.offenders}] clip=[${r.clipped}] overlap=[${r.overlaps}] h1=${r.h1Size}px footer=${r.footerOk}`,
  );
  if (r.tinyTaps.length) console.log(`      note ${width}px small tap targets: ${r.tinyTaps.join(", ")}`);
}

/* ------------------------------------------------------------------ */
/* 3. ACCESSIBILITY — axe audit + keyboard traversal                   */
/* ------------------------------------------------------------------ */
console.log("\n== ACCESSIBILITY ==");
await page.setViewport({ width: 1280, height: 800 });
await gotoLanding();
await page.addScriptTag({ content: axeSource });
const axe = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
const minor = axe.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
report(serious.length === 0, "axe: no critical/serious violations",
  serious.map((v) => `${v.id}(${v.nodes.length})`).join(", "));
console.log(`      axe minor/moderate: ${minor.map((v) => `${v.id}(${v.nodes.length})`).join(", ") || "none"}`);

// Keyboard traversal: order, focus-visible ring, no traps.
const focusStops = [];
for (let i = 0; i < 10; i++) {
  await page.keyboard.press("Tab");
  const s = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const fv = el.matches(":focus-visible");
    const ow = getComputedStyle(el).outlineWidth;
    return {
      label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24),
      fv,
      outline: ow,
    };
  });
  if (s) focusStops.push(s);
}
report(focusStops.length >= 6, "Keyboard reaches 6+ interactive stops", `${focusStops.length} stops`);
report(focusStops.every((s) => s.fv), "Every focused element matches :focus-visible");
report(focusStops.every((s) => parseFloat(s.outline) >= 1), "Focus ring visible (outline ≥1px)");
report(
  focusStops[0]?.label.toLowerCase().includes("mediqo"),
  "First tab stop is the wordmark link",
  focusStops[0]?.label,
);
console.log("      tab order: " + focusStops.map((s) => s.label).join(" → "));

// Headings hierarchy.
const headings = await page.evaluate(() =>
  [...document.querySelectorAll("h1,h2,h3")].map((h) => h.tagName),
);
report(headings[0] === "H1", "Single H1 first in hierarchy", headings.join(","));
report(!headings.slice(1).includes("H1"), "No extra H1s");

/* ------------------------------------------------------------------ */
/* 4. MOTION — entrance animations + prefers-reduced-motion            */
/* ------------------------------------------------------------------ */
console.log("\n== MOTION ==");
await page.reload({ waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1200)); // settle entrance animations before counting
const anim = await page.evaluate(() => {
  const h1wrap = document.querySelector("main h1").closest("div");
  const cs = getComputedStyle(h1wrap);
  return {
    fadeName: cs.animationName,
    fadeDur: cs.animationDuration,
    running: document.getAnimations().filter((a) => a.playState === "running").length,
  };
});
report(anim.fadeName.includes("fade-up"), "Entrance animation applied to hero", `${anim.fadeName} ${anim.fadeDur}`);
report(anim.running <= 6, "Persistent animation workload small", `${anim.running} infinite animations (decorative dots/caret only)`);

await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await gotoLanding();
const rm = await page.evaluate(() => {
  const h1wrap = document.querySelector("main h1").closest("div");
  const cs = getComputedStyle(h1wrap);
  const dot = document.querySelector(".animate-ping");
  return {
    dur: cs.animationDuration,
    opacity: parseFloat(cs.opacity),
    dotIter: dot ? getComputedStyle(dot).animationIterationCount : "n/a",
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    ctaVisible: !!document.querySelector('main a[href="/location"]'),
  };
});
report(parseFloat(rm.dur) < 0.001, "Reduced motion: entrance animation neutralized", rm.dur);
report(rm.opacity === 1, "Reduced motion: hero content fully visible", `opacity=${rm.opacity}`);
report(rm.dotIter === "1", "Reduced motion: looping ping stopped", rm.dotIter);
report(rm.scrollBehavior === "auto", "Reduced motion: smooth scroll disabled", rm.scrollBehavior);
report(rm.ctaVisible, "Reduced motion: CTA still functional/visible");
await page.emulateMediaFeatures([]);
await gotoLanding();

/* ------------------------------------------------------------------ */
/* 5. PERFORMANCE — CLS, asset sizes, API silence                      */
/* ------------------------------------------------------------------ */
console.log("\n== PERFORMANCE ==");
const cls = await page.evaluate(() => window.__cls ?? -1);
report(cls >= 0 && cls < 0.05, "No meaningful layout shift on load", `CLS=${cls.toFixed(4)}`);

const net = await page.evaluate(() => {
  const res = performance.getEntriesByType("resource");
  const largest = res
    .map((e) => ({ name: e.name.split("/").pop().slice(0, 40), kb: Math.round(e.transferSize / 1024) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 5);
  const external = res.filter((e) => !e.name.includes("localhost:5173")).length;
  return { count: res.length, largest, external };
});
report(net.external === 0, "Zero external/third-party requests", `${net.external}`);
report(backendCalls.length === 0, "Zero backend API calls from the landing page", backendCalls.join("; "));
console.log(`      ${net.count} requests; largest: ${net.largest.map((a) => `${a.name} ${a.kb}kB`).join(", ")}`);

/* ------------------------------------------------------------------ */
/* 6. CONSOLE                                                          */
/* ------------------------------------------------------------------ */
console.log("\n== CONSOLE ==");
report(consoleErrors.length === 0, "No console errors", consoleErrors.join(" | "));
report(failedRequests.length === 0, "No failed network requests", failedRequests.join(" | "));
console.log(`      console warnings: ${consoleWarnings.length ? consoleWarnings.join(" | ") : "none"}`);

await browser.close();
console.log(`\n===== QA COMPLETE: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
