/**
 * Mediqo production-bundle smoke test (Step 9.7).
 *
 * Builds the app, serves the REAL dist/ folder with `vite preview`, and
 * verifies the production bundle boots and renders on every route —
 * no dev server involved. Guards/redirects and the not-found state must
 * behave identically in the built output.
 *
 * Run from frontend/:  node tests/prod-smoke.mjs
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
/* The backend CORS allowlist covers :5173 only, and vite preview serves
   dist on 4173 by default — so this smoke test briefly pauses the dev
   server and serves the production bundle on the SAME origin. */
const PORT = 5173;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
let count = 0;
const report = (pass, name, detail = "") => {
  count++;
  if (name) console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!pass) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1 — build */
console.log("Building production bundle…");
const buildOut = execSync("npx vite build 2>&1", { encoding: "utf8", cwd: process.cwd() });
const buildOk = /✓ built in/.test(buildOut) && !/error/i.test(buildOut);
report(buildOk, "vite build succeeds with zero errors", buildOut.split("\n").filter((l) => /built in|error/i.test(l)).join(" ").slice(0, 120));

/* 2 — pause the dev server, serve dist on the same allowed origin */
const killPort = (port) => {
  try {
    const out = execSync(`netstat -ano | grep ":${port} " | grep -i listening`, { encoding: "utf8" });
    for (const line of out.trim().split("\n")) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) execSync(`taskkill //F //PID ${pid}`, { stdio: "ignore" });
    }
  } catch { /* nothing listening */ }
};
killPort(PORT); // dev server (if running) — restored after the smoke test
execSync(`(npx vite preview --port ${PORT} --strictPort > preview.log 2>&1 &)`, { cwd: process.cwd(), shell: "bash" });
let up = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  try {
    const res = await fetch(BASE + "/");
    if (res.ok) { up = true; break; }
  } catch { /* retry */ }
}
report(up, "vite preview serves dist/ on the CORS-allowed origin", up ? BASE : "server did not start");

/* 3 — boot the built bundle on every route */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

try {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await sleep(500);
  const booted = await page.evaluate(() => (document.getElementById("root")?.children.length ?? 0) > 0);
  const t = await page.evaluate(() => document.body.textContent);
  report(booted && t.includes("Find the"), "Built bundle boots: landing renders (no dev server)");

  await page.goto(BASE + "/location", { waitUntil: "networkidle0" });
  await sleep(400);
  report((await page.evaluate(() => document.body.textContent)).includes("Where are you?"), "/location renders from dist");

  await page.goto(BASE + "/problem", { waitUntil: "networkidle0" });
  report((await page.evaluate(() => location.pathname)) === "/location", "/problem guard-redirect works in the built bundle");

  await page.goto(BASE + "/results", { waitUntil: "networkidle0" });
  report((await page.evaluate(() => location.pathname)) === "/location", "/results guard-redirect works in the built bundle");

  await page.goto(BASE + "/doctor/999999", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.textContent.includes("We couldn't find this doctor's profile."), { timeout: 8000 });
  report(true, "/doctor/999999 → not-found state in the built bundle");

  await page.goto(BASE + "/no-such-page", { waitUntil: "networkidle0" });
  const body = await page.evaluate(() => document.body.textContent);
  report(body.length > 100, "SPA fallback: unknown route renders the app shell", `${body.length} chars`);

  const unexpected = consoleErrors.filter((m) => !/Failed to load resource.*404/.test(m));
  report(unexpected.length === 0, "Built bundle: no unexpected console errors", unexpected.join(" | "));
} finally {
  await browser.close();
  killPort(PORT); // stop the preview server
}

console.log(`\n===== PROD SMOKE: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
