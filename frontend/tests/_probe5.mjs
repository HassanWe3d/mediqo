import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5173";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message?.slice(0, 400)));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 300)); });

await page.evaluateOnNewDocument(() => {
  let cfg = {};
  try { cfg = JSON.parse(window.name || "{}"); } catch { cfg = {}; }
  const realFetch = window.fetch.bind(window);
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const MOCK_DOCTOR = {
    id: 1, name: "Dr. Aditi Verma", specialization: "Dentist", qualification: "BDS, MDS",
    experience_years: 9, languages: ["English", "Hindi"], consultation_fee: 600,
    clinic_name: "Demo Dental Care", address: "12 Demo Road, Hazratganj", city: "Lucknow",
    latitude: 26.85, longitude: 80.95, rating: 4.8, review_count: 24,
    availability: { mon: [["10:00", "14:00"]], wed: [], sun: [] },
    bio: "Bio text.", profile_image: null, verified: false, is_demo: true,
    availability_summary: "Mon-Fri", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
  window.__apiCalls = [];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    window.__apiCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (/\/doctors\/\d+\/reviews/.test(url)) return reply(200, { doctor_id: 1, reviews: [], total: 0, page: 1, page_size: 10 });
    if (/\/doctors\/\d+($|\?)/.test(url)) return reply(200, MOCK_DOCTOR);
    return realFetch(input, init);
  };
  try {
    if (cfg.resetStorage) {
      sessionStorage.clear();
      if (cfg.seedLocation) sessionStorage.setItem("mediqo.flow.location", JSON.stringify(cfg.seedLocation));
      if (cfg.seedProblem) sessionStorage.setItem("mediqo.flow.problem", cfg.seedProblem);
      if (cfg.seedAnalysis) sessionStorage.setItem("mediqo.flow.analysis", JSON.stringify(cfg.seedAnalysis));
    }
  } catch {}
});

await page.evaluate((c) => { window.name = JSON.stringify(c); }, {
  resetStorage: true,
  seedLocation: { method: "city", label: "Lucknow", latitude: 26.8467, longitude: 80.9462 },
  seedProblem: "tooth pain",
  seedAnalysis: { specialization: "Dentist", urgency: "normal", summary: "s", possible_keywords: [] },
});

await page.goto(BASE + "/doctor/1", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 700));
const state = await page.evaluate(() => ({
  path: location.pathname,
  calls: window.__apiCalls,
  body: document.body.textContent.slice(0, 400),
  rootChildren: document.getElementById("root")?.children.length ?? 0,
}));
console.log(JSON.stringify(state, null, 2));

await browser.close();
