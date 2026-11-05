// Assets for video 2: screenshots of every page state the cut shows, X-ray boxes from the audit scorer,
// and the Take D timeline. Take D's page fetches data.json at runtime, so its states are served through
// page.route on a virtual host (no local server is opened for them).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");

// VIDEO2_WORK holds the rebuilt Take C/D states (build_states.py output) and Take D's ui.cast; they stay outside the
// repo because the recordings show the model name. The audit scorer must be running on :7788.
const S = process.env.VIDEO2_WORK ?? process.cwd();
const R = "/home/user/verdict/examples/demo/ui-loop";
const OUT = `${S}/edit2/assets`; // edit2.mjs reads ./assets next to itself: run both from $VIDEO2_WORK/edit2
mkdirSync(`${OUT}/shots`, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
await ctx.route("http://take.local/**", (route) => {
  const u = new URL(route.request().url());
  const [, take, file] = u.pathname.split("/");
  const dir = { b: `${R}/take-b/evaluated`, c: `${S}/takeC/rebuilt/states`, d: `${S}/takeD/rebuilt/states`, s: `${R}/start` }[take];
  const path = file === "data.json" ? `${R}/start/data.json` : `${dir}/${file || "index.html"}`;
  return route.fulfill({ path, contentType: path.endsWith(".json") ? "application/json" : "text/html" });
});
const page = await ctx.newPage();
async function shot(url, name) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/shots/${name}.png` });
}

await shot("http://take.local/s/index.html", "start");
for (let k = 0; k <= 5; k++) await shot(`http://take.local/b/step${k}.html`, `b${k}`);
await shot("http://take.local/c/08.html", "c-final");
for (let k = 0; k <= 8; k++) await shot(`http://take.local/d/${String(k).padStart(2, "0")}.html`, `d${String(k).padStart(2, "0")}`);

// Take C: locate the sentences P12 flagged (writes_for_user 10%) so the cut can point at them.
await page.goto("http://take.local/c/08.html", { waitUntil: "networkidle" });
await page.waitForTimeout(2600);
const metaCopy = await page.evaluate((needles) => needles.flatMap((n) => {
  const el = [...document.querySelectorAll("body *")].find((e) => e.textContent.includes(n) && ![...e.children].some((c) => c.textContent.includes(n)));
  if (!el) return [];
  const r = el.getBoundingClientRect();
  return [{ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), label: "copy written for the judge (P12)" }];
}), ["Flagged here first", "this is direction, not progress"]);

// Audit boxes (same scorer the rubric calls), page coordinates at 1280 px.
const raw = async (u) => (await fetch(`http://127.0.0.1:7788/raw?url=${encodeURIComponent(u)}`)).json();
const pick = (a, keys) => keys.flatMap((k) => (a[k]?.boxes ?? []).map((b) => ({ ...b, kind: k })));
const startAudit = await raw("http://127.0.0.1:8768/start/");
const cAudit = await raw("http://127.0.0.1:8769/");
const tl = JSON.parse(readFileSync(`${S}/takeD/rebuilt/timeline.json`, "utf8"));
const cast = readFileSync(`${S}/takeD/ui.cast`, "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === "o").map((e) => [e[0], e[2]]);
const bEvals = JSON.parse(readFileSync(`${R}/take-b/evaluations.json`, "utf8")).evaluations.map((e) => e.score);

writeFileSync(`${OUT}/data.json`, JSON.stringify({
  xray: {
    start: pick(startAudit, ["decoration", "template_chrome", "chart_types", "motion"]).filter((b) => b.w > 0 && b.h > 0),
    startCounts: { decoration: startAudit.decoration.count, chrome: startAudit.template_chrome.count, charts: startAudit.chart_types.count, motion: startAudit.motion.count, font: startAudit.fonts.rendered[0] },
    c: [...pick(cAudit, ["template_chrome"]).filter((b) => b.w > 0 && b.h > 0), ...metaCopy],
    cFont: cAudit.fonts.rendered[0],
  },
  takeB: { v1: bEvals, v21Final: 49 },
  takeC: { v2: 82, v21: 71 },
  start: { v1: 27, v21: 33 },
  takeD: { markers: tl.markers, states: tl.states.map((s) => ({ src: s.src, shot: `d${s.file.slice(7, 9)}` })), evals: tl.evals.map((e) => ({ src: e.src, name: e.name, score: e.score, grade: e.grade, criteria: e.criteria.map((c) => ({ id: c.id, name: c.name, n: c.n })) })) },
  cast,
}));
await browser.close();
console.log("assets ok:", { startBoxes: startAudit.decoration.count + startAudit.template_chrome.count, cBoxes: metaCopy.length, castEvents: cast.length });
