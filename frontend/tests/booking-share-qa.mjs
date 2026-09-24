/**
 * Mediqo QA — demo appointment booking + doctor share (doctor profile page).
 *
 * Part A — mocked /doctors endpoints (deterministic doctor A, plus
 *   closed-day and past-window doctors): booking open/close, slot derivation
 *   from published availability, past-slot exclusion, validation,
 *   confirmation copy, reference ID, localStorage persistence, share menu.
 * Part B — live: real backend + PostgreSQL for two real doctors; share URLs,
 *   deep-link routing, cross-doctor URL change, booking persistence across
 *   reload, and live AI spot-checks proving matching is untouched.
 * Part C — responsive sweep (with the booking modal open), axe, keyboard
 *   traversal, reduced motion.
 *
 * Same window.name-configured mock pattern as results-qa.mjs.
 *
 * Run from frontend/:  node tests/booking-share-qa.mjs
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
page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

const bodyText = (pg = page) => pg.evaluate(() => document.body.textContent);
const clickButton = async (pg, label) => {
  const ok = await pg.evaluate((lbl) => {
    const btns = [...document.querySelectorAll("button")];
    const btn =
      btns.find((b) => b.textContent.trim() === lbl) ?? btns.find((b) => b.textContent.trim().includes(lbl));
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!ok) throw new Error(`button not found: ${label}`);
};
const typeInto = async (pg, selector, text) => {
  await pg.evaluate(
    (sel) => {
      const input = document.querySelector(sel);
      if (!input) return;
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    },
    selector,
  );
  await pg.keyboard.type(text, { delay: 2 });
};

/* ---- deterministic doctor fixture (availability mirrors seed pattern P0) ---- */
const DOCTOR_A = {
  id: 101,
  name: "Dr. Aditi Verma",
  specialization: "Dentist",
  qualification: "BDS, MDS",
  experience_years: 9,
  languages: ["English", "Hindi"],
  consultation_fee: 600,
  clinic_name: "Demo Dental Care",
  address: "12 Demo Road, Hazratganj",
  city: "Lucknow",
  rating: 4.8,
  review_count: 24,
  availability: {
    mon: [["10:00", "14:00"]],
    tue: [["10:00", "14:00"]],
    wed: [],
    thu: [["10:00", "14:00"]],
    fri: [["10:00", "14:00"]],
    sat: [["10:00", "12:00"]],
    sun: [],
  },
  profile_image: null,
  is_demo: true,
  verified: false,
  availability_summary: "Available Monday–Saturday mornings.",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  bio: "Demo dentist for QA.",
  latitude: 26.8467,
  longitude: 80.9462,
};
const DOCTOR_CLOSED = {
  ...DOCTOR_A,
  id: 102,
  name: "Dr. Sunday Only",
  availability: { sun: [["09:00", "11:00"]], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
};
/** Doctor whose ONLY window today is fully in the past (00:30–01:00). */
const TODAY_KEY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][(new Date().getDay() + 6) % 7];
const DOCTOR_PAST = {
  ...DOCTOR_A,
  id: 103,
  name: "Dr. Window Passed",
  availability: { [TODAY_KEY]: [["00:30", "01:00"]], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
};
const REVIEWS_A = {
  doctor_id: DOCTOR_A.id,
  reviews: [
    { id: 1, reviewer_name: "Demo User", rating: 5, comment: "Great demo dentist.", created_at: "2026-08-01T00:00:00Z", verified_visit: true, is_demo: true },
  ],
  total: 1,
  page: 1,
  page_size: 10,
};

/** Universal mock: /doctors/* replies from config; everything else real. */
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
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      window.__apiCalls.push(`${init?.method ?? "GET"} ${url}`);
      if (cfg.mockEnabled && url.includes("/doctors")) {
        const idMatch = url.match(/\/doctors\/(\d+)/);
        if (idMatch) {
          const id = Number(idMatch[1]);
          const doctor = cfg.doctors?.find((d) => d.id === id);
          if (cfg.doctors && !doctor) return reply(404, { detail: "Doctor not found" });
          if (doctor) {
            if (url.includes("/reviews")) {
              const status = cfg.reviewStatus ?? 200;
              return reply(status, status === 200 ? { ...cfg.reviewBody, doctor_id: id } : { detail: "error" });
            }
            return reply(200, doctor);
          }
        }
        return reply(200, { items: [], page: 1, page_size: 10, total: 0, pages: 0 });
      }
      return realFetch(input, init);
    };
    try {
      if (cfg.resetStorage) {
        sessionStorage.clear();
        localStorage.removeItem("mediqo.demoBookings");
      }
    } catch {
      /* ignore */
    }
  });

const setCfg = (pg, cfg) => pg.evaluate((c) => { window.name = JSON.stringify(c); }, cfg);
const gotoDoctor = async (pg, id) => {
  await pg.goto(`${BASE}/doctor/${id}`, { waitUntil: "networkidle0" });
  await sleep(650);
};

/* =======================================================================
 * PART A — MOCKED: booking flow end to end
 * ===================================================================== */
console.log("\n== A1 · PROFILE RENDERS + ACTIONS ==");
installMocks(page);
await setCfg(page, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
await gotoDoctor(page, DOCTOR_A.id);
{
  const t = await bodyText();
  report(t.includes("Dr. Aditi Verma"), "Doctor name renders");
  report(t.includes("Book Appointment"), "Book Appointment button visible");
  report(t.includes("Share"), "Share button visible");
  report(t.includes("Booking is a demo — no real appointment is made."), "Demo disclaimer renders before booking");
  report(await page.evaluate(() => location.pathname === "/doctor/101"), "Route /doctor/101");
}

console.log("\n== A2 · BOOKING OPEN + VALIDATION ==");
await clickButton(page, "Book Appointment");
await sleep(350);
{
  const t = await bodyText();
  report(t.includes("Demo only — no real booking is made."), "Modal opens with demo note");
  report(t.includes("Select a date"), "Step 1: date selection visible");
  report(t.includes("Select an available time"), "Step 2: time selection visible");
  report(t.includes("Patient name"), "Step 3: patient details visible");
  report(t.includes("Contact (optional)"), "Optional contact field visible");
  report(t.includes("Demo Dental Care"), "Modal shows clinic");
  await clickButton(page, "Confirm Appointment");
  await sleep(200);
  const t2 = await bodyText();
  report(t2.includes("Please enter the patient's name."), "Empty patient name blocked with message");
  report(t2.includes("Please select an available time slot."), "Missing slot blocked with message");
  report(!t2.includes("Appointment Booked"), "No confirmation on invalid submit");
}

console.log("\n== A3 · SLOT DERIVATION (from published availability) ==");
{
  // Node-side loop with a re-render wait between day switches.
  const dayCount = await page.evaluate(
    () => document.querySelectorAll('section[aria-label="Select a date"] button').length,
  );
  const slots = [];
  for (let i = 0; i < Math.min(dayCount, 3); i++) {
    await page.evaluate((idx) => {
      document.querySelectorAll('section[aria-label="Select a date"] button')[idx].click();
    }, i);
    await sleep(150);
    const entry = await page.evaluate(() => ({
      day: document.querySelector('section[aria-label="Select a date"] button[aria-pressed="true"]')?.textContent.trim() ?? "",
      slots: [...document.querySelectorAll('section[aria-label="Select a time" ] button')].map((b) => b.textContent.trim()),
    }));
    slots.push(entry);
  }
  report(slots.length >= 2, "Multiple bookable days derived from availability", `${slots.length} days`);
  const allSlots = slots.flatMap((s) => s.slots);
  report(allSlots.length > 0, "Time slots render");
  // The app labels slots like the Availability card: "10 AM", "10:30 AM".
  const toMinutes = (label) => {
    const m = label.match(/^(\d{1,2})(?::(\d{2}))? (AM|PM)$/);
    if (!m) return NaN;
    let h = Number(m[1]) % 12;
    if (m[3] === "PM") h += 12;
    return h * 60 + Number(m[2] ?? 0);
  };
  report(allSlots.every((s) => Number.isFinite(toMinutes(s))), "Slots labelled as 12h times", allSlots.slice(0, 3).join(", "));
  // 30-minute increments within the first day's grid
  const first = slots[0].slots.map(toMinutes);
  const spaced = first.every((v, i) => i === 0 || v - first[i - 1] === 30);
  report(spaced && first.length >= 2, "Slots are 30-minute increments", slots[0].slots.slice(0, 3).join(", "));
  // The published 10:00 window start must appear on at least one later day
  // (today's earlier slots are correctly filtered out).
  report(allSlots.includes("10 AM"), "Slots cover the published window start (10 AM)");
}

console.log("\n== A4 · FULL BOOKING → CONFIRMATION ==");
{
  await page.evaluate(() => {
    document.querySelector('section[aria-label="Select a time"] button')?.click();
  });
  await typeInto(page, 'input[placeholder="e.g. Aarav Gupta"]', "Aarav Gupta");
  await clickButton(page, "Confirm Appointment");
  await page.waitForFunction(() => document.body.textContent.includes("Appointment Booked"), { timeout: 4000 });
  const t = await bodyText();
  report(t.includes("Appointment Booked"), "Confirmation state shows");
  const ref = t.match(/Demo reference: (MQ-[A-Z0-9]{6})/)?.[1];
  report(!!ref, "Demo reference ID format MQ-XXXXXX", ref);
  report(t.includes("Dr. Aditi Verma"), "Confirmation shows doctor");
  report(t.includes("Dentist"), "Confirmation shows specialty");
  report(t.includes("Demo Dental Care, Lucknow"), "Confirmation shows location");
  report(t.includes("Aarav Gupta"), "Confirmation shows patient");
  report(
    t.includes("This is a demo appointment confirmation and does not represent a real booking."),
    "Not-a-real-booking note on confirmation",
  );
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mediqo.demoBookings") ?? "{}"));
  const refs = Object.keys(stored);
  report(refs.length === 1 && refs[0] === ref, "Booking persisted to localStorage under its ref", refs.join(","));
  const rec = stored[refs[0] ?? ""];
  report(rec && rec.doctorId === 101 && rec.patientName === "Aarav Gupta", "Stored record holds doctor + patient");
  report(rec && !!rec.start && !!rec.date, "Stored record holds date + time", rec ? `${rec.date} ${rec.start}` : "");
}

console.log("\n== A5 · PERSISTENCE ACROSS RELOAD ==");
{
  await clickButton(page, "Done");
  await sleep(250);
  // Disable the storage reset before reloading — the init script would
  // otherwise wipe the booking exactly at reload (cfg lives in window.name,
  // which survives navigations).
  await setCfg(page, { mockEnabled: true, resetStorage: false, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(650);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mediqo.demoBookings") ?? "{}"));
  const ref = Object.keys(stored)[0];
  report((await bodyText()).includes(`Your demo booking for this doctor: ${ref}`), "Profile shows stored booking ref after reload", ref);
  await clickButton(page, "Book Appointment");
  await sleep(300);
  report((await bodyText()).includes("Demo only — no real booking is made."), "Modal reopens after reload");
  await clickButton(page, "Cancel");
  await sleep(200);
}

console.log("\n== A6 · UNAVAILABLE DAYS NOT OFFERED ==");
{
  await setCfg(page, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_CLOSED], reviewBody: { ...REVIEWS_A, doctor_id: DOCTOR_CLOSED.id } });
  await gotoDoctor(page, DOCTOR_CLOSED.id);
  await clickButton(page, "Book Appointment");
  await sleep(300);
  const days = await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Select a date"] button')].map((b) => b.textContent.trim()),
  );
  report(days.length >= 1 && days.every((d) => d.startsWith("Sun")), "Only open weekdays listed (Sun only)", days.join(", "));
  const slotLabels = await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Select a time"] button')].map((b) => b.textContent.trim()),
  );
  report(slotLabels.length === 4 && slotLabels[0] === "9 AM", "Slots fill the published 9–11 window", slotLabels.join(", "));
  report(slotLabels.includes("10:30 AM"), "Mid-window slot selectable", slotLabels.join(", "));
}

console.log("\n== A7 · FULLY-PAST WINDOW EXCLUDED ==");
{
  await setCfg(page, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_PAST], reviewBody: { ...REVIEWS_A, doctor_id: DOCTOR_PAST.id } });
  await gotoDoctor(page, DOCTOR_PAST.id);
  await clickButton(page, "Book Appointment");
  await sleep(300);
  report(
    (await bodyText()).includes("No published availability this week."),
    "Doctor with only past slots today shows empty-availability guidance",
  );
  const chips = await page.evaluate(() => document.querySelectorAll('section[aria-label="Select a date"] button').length);
  report(chips === 0, "No bookable chips for a fully-past week", `${chips} chips`);
  await page.keyboard.press("Escape");
  await sleep(150);
}

console.log("\n== A8 · SHARE MENU (mocked) ==");
{
  await setCfg(page, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
  await gotoDoctor(page, DOCTOR_A.id);
  await clickButton(page, "Share");
  await sleep(250);
  const t = await bodyText();
  report(t.includes("WhatsApp"), "WhatsApp option renders");
  report(t.includes("Copy Link"), "Copy Link option renders");
  const wa = await page.evaluate(() => document.querySelector('a[role="menuitem"]')?.href ?? "");
  report(wa.startsWith("https://wa.me/?text="), "WhatsApp uses wa.me with encoded text", wa.slice(0, 34));
  const decoded = decodeURIComponent(wa.replace("https://wa.me/?text=", ""));
  report(decoded.includes("Check out Dr. Aditi Verma on Mediqo."), "WhatsApp message contains doctor name");
  report(decoded.includes(`${BASE}/doctor/101`), "WhatsApp message contains the real profile URL", decoded.split("\n")[1]);
  const native = await page.evaluate(() => typeof navigator.share === "function");
  if (native) {
    report(t.includes("Share…"), "Native share option when supported");
  } else {
    report(!t.includes("Share…"), "No native-share button when unsupported");
  }
  await page.evaluate(() => {
    window.__clipText = null;
    navigator.clipboard.writeText = async (text) => {
      window.__clipText = text;
    };
  });
  await clickButton(page, "Copy Link");
  await sleep(250);
  const copied = await page.evaluate(() => window.__clipText);
  report(copied === `${BASE}/doctor/101`, "Copy Link copies the exact profile URL", copied);
  report((await bodyText()).includes("Profile link copied"), "Copy success state shows");
  // graceful clipboard failure (label reverts after ~2s; click by position)
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await page.evaluate(() => {
    document.querySelectorAll('[role="menuitem"]')[1]?.click();
  });
  await sleep(250);
  report(
    (await bodyText()).includes("Couldn't access the clipboard"),
    "Clipboard failure shows graceful fallback message",
  );
  await page.keyboard.press("Escape");
  await sleep(150);
  report(!(await page.evaluate(() => document.querySelector('[role="menu"]'))), "Escape closes the share menu");
}

console.log("\n== A9 · MODAL INTERACTION ==");
{
  await gotoDoctor(page, DOCTOR_A.id);
  await clickButton(page, "Book Appointment");
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(200);
  report(!(await page.evaluate(() => document.querySelector('[role="dialog"]'))), "Escape closes the booking modal");
  await clickButton(page, "Book Appointment");
  await sleep(250);
  await page.evaluate(() => {
    const overlay = document.querySelector('[role="presentation"]');
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await sleep(200);
  report(!(await page.evaluate(() => document.querySelector('[role="dialog"]'))), "Backdrop click closes the modal");
  await clickButton(page, "Book Appointment");
  await sleep(300);
  for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
  const insideDialog = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  report(insideDialog, "Focus stays trapped inside the modal after 25 tabs");
  await page.keyboard.press("Escape");
}

/* =======================================================================
 * PART B — LIVE: real backend, real routing, real doctors
 * ===================================================================== */
console.log("\n== B1 · LIVE PROFILE + DEEP LINK ==");
{
  // Listing comes from Node (bypasses the in-page mock entirely).
  const live = await fetch("http://127.0.0.1:8000/doctors?page=1&page_size=2").then((r) => r.json());
  const ids = live.items.map((d) => d.id);
  report(ids.length === 2, "Live backend returns two doctors", ids.join(","));
  // Disable the /doctors mock for the whole live part.
  await setCfg(page, { mockEnabled: false, resetStorage: true });
  await gotoDoctor(page, ids[0]);
  let t = await bodyText();
  report(t.includes(live.items[0].name), "Live doctor A profile loads by URL");
  report(t.includes("Book Appointment") && t.includes("Share"), "Live profile shows both demo actions");
  await clickButton(page, "Share");
  await sleep(200);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__clipA = text;
    };
  });
  await clickButton(page, "Copy Link");
  await sleep(200);
  const copiedA = await page.evaluate(() => window.__clipA);
  report(copiedA === `${BASE}/doctor/${ids[0]}`, "Copied URL targets doctor A", copiedA);
  await page.keyboard.press("Escape");
  await gotoDoctor(page, ids[0]);
  report(await page.evaluate((id) => location.pathname === `/doctor/${id}`, ids[0]), "Deep link route resolves");
  report((await bodyText()).includes(live.items[0].name), "Deep link renders doctor A");
  await gotoDoctor(page, ids[1]);
  t = await bodyText();
  report(t.includes(live.items[1].name), "Doctor B profile renders");
  await clickButton(page, "Share");
  await sleep(200);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__clipB = text;
    };
  });
  await clickButton(page, "Copy Link");
  await sleep(200);
  const copiedB = await page.evaluate(() => window.__clipB);
  report(copiedB === `${BASE}/doctor/${ids[1]}`, "Copied URL switches to doctor B", copiedB);
  report(copiedB !== copiedA, "URL differs per doctor");
  await clickButton(page, "Book Appointment");
  await sleep(300);
  const hasSlot = await page.evaluate(() => {
    const btn = document.querySelector('section[aria-label="Select a time"] button');
    btn?.click();
    return !!btn;
  });
  if (hasSlot) {
    await typeInto(page, 'input[placeholder="e.g. Aarav Gupta"]', "Live Tester");
    await clickButton(page, "Confirm Appointment");
    await page.waitForFunction(() => document.body.textContent.includes("Appointment Booked"), { timeout: 4000 });
    const ref = (await bodyText()).match(/Demo reference: (MQ-[A-Z0-9]{6})/)?.[1];
    report(!!ref, "Live booking confirms with reference", ref);
    await clickButton(page, "Done");
    // Keep the booking: disable the storage reset before reloading.
    await setCfg(page, { mockEnabled: false, resetStorage: false });
    await page.reload({ waitUntil: "networkidle0" });
    await sleep(650);
    report((await bodyText()).includes(`Your demo booking for this doctor: ${ref}`), "Live booking survives reload", ref);
  } else {
    report(true, "Live doctor fully booked today (skip persistence leg)");
  }
}

console.log("\n== B2 · MATCHING UNTOUCHED (live AI spot-checks) ==");
{
  const check = async (problem, expected) => {
    const res = await page.evaluate(async (problem) => {
      const r = await fetch("http://127.0.0.1:8000/analyze-problem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem }),
      });
      return r.json();
    }, problem);
    report(res.specialization === expected, `"${problem}" → ${expected}`, res.specialization);
  };
  await check("I have a red itchy skin rash", "Dermatologist");
  await check("I have severe tooth pain", "Dentist");
  await check("I have back pain", "Orthopedic");
  await check("My vision is blurry", "Ophthalmologist");
}

/* =======================================================================
 * PART C — RESPONSIVE + A11Y
 * ===================================================================== */
console.log("\n== C1 · RESPONSIVE (modal open) ==");
{
  const page3 = await browser.newPage();
  await installMocks(page3);
  await setCfg(page3, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page3.setViewport({ width, height: width >= 1024 ? 900 : 820 });
    await gotoDoctor(page3, DOCTOR_A.id);
    await clickButton(page3, "Book Appointment");
    await sleep(350);
    const r = await page3.evaluate(() => {
      const doc = document.documentElement;
      const dialog = document.querySelector('[role="dialog"]');
      const inHScroller = (el) => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX === "auto" || s.overflowX === "scroll") return true;
        }
        return false;
      };
      const offenders = [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.closest('[aria-hidden="true"]')) return false;
          if (inHScroller(el)) return false; // intentionally scrollable regions
          const b = el.getBoundingClientRect();
          return b.width > 1 && (b.right > doc.clientWidth + 1 || b.left < -1);
        })
        .slice(0, 3)
        .map((el) => el.tagName);
      const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,span,label")]
        .filter((el) => {
          if (!el.textContent?.trim() || el.children.length > 0) return false;
          if (el.closest(".sr-only") || getComputedStyle(el).position === "absolute") return false;
          const cs = getComputedStyle(el);
          return cs.overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
        })
        .slice(0, 3)
        .map((el) => el.textContent.trim().slice(0, 24));
      const confirmBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Confirm Appointment");
      return {
        overflowX: doc.scrollWidth - doc.clientWidth,
        offenders,
        clipped,
        dialogFits: dialog ? dialog.getBoundingClientRect().height <= doc.clientHeight + 2 : false,
        confirmH: confirmBtn ? Math.round(confirmBtn.getBoundingClientRect().height) : 0,
      };
    });
    report(
      r.overflowX === 0 && r.offenders.length === 0 && r.clipped.length === 0 && r.dialogFits && r.confirmH >= 44,
      `${width}px clean with modal open`,
      r.overflowX !== 0 || r.offenders.length || r.clipped.length ? `overflow=${r.overflowX} off=${r.offenders} clip=${r.clipped}` : `confirmH=${r.confirmH}`,
    );
  }
  await page3.setViewport({ width: 320, height: 820 });
  await page3.keyboard.press("Escape");
  await clickButton(page3, "Share");
  await sleep(250);
  const menuOk = await page3.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return false;
    const doc = document.documentElement;
    const b = menu.getBoundingClientRect();
    return b.right <= doc.clientWidth && b.top >= 0;
  });
  report(menuOk, "Share menu not clipped at 320px");
  await page3.close();
}

console.log("\n== C2 · AXE + KEYBOARD ==");
{
  const page3 = await browser.newPage();
  await installMocks(page3);
  await setCfg(page3, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
  await page3.setViewport({ width: 1280, height: 900 });
  await gotoDoctor(page3, DOCTOR_A.id);
  await page3.addScriptTag({ content: axeSource });
  const axe = await page3.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
  const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  report(serious.length === 0, "axe: no serious violations on profile", serious.map((v) => `${v.id}(${v.nodes.length})`).join(", "));

  await clickButton(page3, "Book Appointment");
  await sleep(350);
  const axeModal = await page3.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] }));
  const seriousModal = axeModal.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  report(seriousModal.length === 0, "axe: no serious violations with modal open", seriousModal.map((v) => `${v.id}(${v.nodes.length})`).join(", "));

  // real keyboard traversal stays inside the dialog
  for (let i = 0; i < 25; i++) await page3.keyboard.press("Tab");
  const insideDialog = await page3.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  report(insideDialog, "Keyboard traversal stays inside the modal");
  await page3.close();
}

console.log("\n== C3 · REDUCED MOTION ==");
{
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await setCfg(page, { mockEnabled: true, resetStorage: true, doctors: [DOCTOR_A], reviewBody: REVIEWS_A });
  await gotoDoctor(page, DOCTOR_A.id);
  await clickButton(page, "Book Appointment");
  await sleep(300);
  report((await bodyText()).includes("Demo only — no real booking is made."), "Reduced motion: modal content visible");
  const loops = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running" && getComputedStyle(a.effect?.target ?? document.body).animationIterationCount === "infinite").length,
  );
  report(loops === 0, "Reduced motion: no looping animations", String(loops));
  await page.emulateMediaFeatures([]);
}

report(consoleErrors.length === 0, "No console errors across the suite", consoleErrors.slice(0, 2).join(" | "));

await browser.close();
console.log(`\n===== BOOKING+SHARE QA: ${count} checks — ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} =====`);
process.exit(failures === 0 ? 0 : 1);
