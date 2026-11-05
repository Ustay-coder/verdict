#!/usr/bin/env node
// Render-audit scorer for Verdict's `http` benchmark judge.
//
//   node examples/demo/ui-loop/audit/server.mjs [port=7788]
//   rubric: judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/contrast" }
//
// Verdict POSTs { criterion, evidence, text }. We take the first `url` evidence source, render it in Chromium
// (1280×800, once per page version), measure, and answer { normalized, rationale, value, boxes } where `boxes`
// are the offending elements in page coordinates (used for the video's overlay). Metrics:
//   contrast    share of visible text passing WCAG AA against its effective background
//   decoration  gradients, gradient text, glass (backdrop-filter), glows, text-shadows, filters (incl. ::before/::after)
//   motion      infinite animations running on the page
//   type_scale  distinct font sizes in visible text
//   palette     distinct saturated hue families (12 × 30°) across text, backgrounds, borders, gradients, SVG
//   chart_types angle/area encodings: SVG donut rings (dasharray circles), arc-path pies, conic-gradient rings
//   template_chrome  tracked all-caps eyebrows, one accented word inside a headline, icon tiles (small boxes holding an icon)
//   repeated_figures the same figure shown 3+ times (48.2k and $48,200 count as the same value)
//   numerals    share of numeric text set with tabular figures (or a monospace face)
//   numbers_true every figure on screen derives from the json evidence (data.json): leaves, sums, shares, ratios, % changes
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const port = Number(process.argv[2] ?? 7788);
const browser = await chromium.launch();
const cache = new Map(); // url + content hash -> audit

async function audit(url) {
  const html = await (await fetch(url)).text();
  const key = `${url}#${createHash("sha1").update(html).digest("hex")}`;
  if (cache.has(key)) return cache.get(key);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(2500); // let count-up and entrance animations finish
    const result = await page.evaluate(measure);
    cache.set(key, result);
    return result;
  } finally { await page.close(); }
}

// Runs in the page.
function measure() {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, under) => { const a = top.a + under.a * (1 - top.a); if (!a) return { r: 0, g: 0, b: 0, a: 0 }; return { r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a, g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a, b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a, a }; };
  const stops = (img) => [...(img || "").matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter(Boolean);
  const avg = (cs) => cs.length ? { r: cs.reduce((s, c) => s + c.r, 0) / cs.length, g: cs.reduce((s, c) => s + c.g, 0) / cs.length, b: cs.reduce((s, c) => s + c.b, 0) / cs.length, a: cs.reduce((s, c) => s + c.a, 0) / cs.length } : null;
  const box = (el, label) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), label }; };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0; };
  const all = [...document.querySelectorAll("body *")].filter(visible);

  // effective background: composite ancestor backgrounds (gradients approximated by the mean of their stops)
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      const c = parse(s.backgroundColor); const g = avg(stops(s.backgroundImage));
      if (g) layers.push(g);
      if (c && c.a > 0) layers.push(c);
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };

  // text elements: elements with their own non-empty text
  const texts = all.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0));
  const fails = [];
  const sizes = new Set();
  for (const el of texts) {
    const s = getComputedStyle(el);
    sizes.add(Math.round(parseFloat(s.fontSize)));
    let fg = parse(s.color);
    if (!fg) continue;
    const clipText = s.webkitBackgroundClip === "text" || s.backgroundClip === "text";
    if (clipText) { const g = avg(stops(s.backgroundImage)); if (g) fg = { ...g, a: 1 }; }
    const bg = bgOf(el.parentElement || el);
    const fgc = over({ ...fg, a: fg.a * Number(s.opacity) }, bg);
    const [L1, L2] = [lum(fgc), lum(bg)].sort((a, b) => b - a);
    const ratio = (L1 + 0.05) / (L2 + 0.05);
    const px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) fails.push(box(el, `contrast ${ratio.toFixed(2)}:1`));
  }

  // decoration (elements + pseudo elements)
  const deco = [];
  const decoReasons = (s) => {
    const why = [];
    if (/gradient\(/.test(s.backgroundImage)) why.push(s.webkitBackgroundClip === "text" || s.backgroundClip === "text" ? "gradient text" : "gradient");
    if (s.backdropFilter && s.backdropFilter !== "none") why.push("glass blur");
    if (s.boxShadow && s.boxShadow !== "none") {
      const glow = [...s.boxShadow.matchAll(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/g)].some(([, c, , , blur]) => { const p = parse(c); const sat = p ? Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) : 0; return Number(blur) >= 18 || sat > 60; });
      if (glow) why.push("glow");
    }
    if (s.textShadow && s.textShadow !== "none") why.push("text glow");
    if (s.filter && /blur|drop-shadow/.test(s.filter)) why.push("filter");
    return why;
  };
  for (const el of all) {
    for (const pseudo of [null, "::before", "::after"]) {
      const s = getComputedStyle(el, pseudo);
      if (pseudo && (s.content === "none" || s.content === "normal")) continue;
      const why = decoReasons(s);
      if (why.length) deco.push(box(el, `${why.join(" + ")}${pseudo ? ` (${pseudo})` : ""}`));
    }
  }
  // svg gradients / glows
  for (const g of document.querySelectorAll("svg linearGradient, svg radialGradient")) { const svg = g.closest("svg"); if (svg && visible(svg)) deco.push(box(svg, "svg gradient")); }
  for (const f of document.querySelectorAll("svg filter")) { const svg = f.closest("svg"); if (svg && visible(svg)) deco.push(box(svg, "svg filter (glow)")); }

  // motion
  const anims = document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations === Infinity);
  const motion = anims.map((a) => (a.effect?.target instanceof Element ? box(a.effect.target, `infinite ${a.animationName ?? "animation"}`) : null)).filter(Boolean);

  // palette: saturated hue families
  const hues = new Map();
  const addColor = (c, el) => {
    const p = typeof c === "string" ? parse(c) : c; if (!p || p.a < 0.15) return;
    const r = p.r / 255, g = p.g / 255, b = p.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (d < 0.12 || l < 0.08 || l > 0.95) return;
    const s = d / (1 - Math.abs(2 * l - 1)); if (s < 0.25) return;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360;
    const bin = Math.floor(h / 30);
    if (!hues.has(bin)) hues.set(bin, { n: 0, el }); hues.get(bin).n++;
  };
  for (const el of all) {
    const s = getComputedStyle(el);
    addColor(s.color, el); addColor(s.backgroundColor, el); addColor(s.borderTopColor, el);
    for (const c of stops(s.backgroundImage)) addColor(c, el);
    if (el instanceof SVGElement) { addColor(s.fill, el); addColor(s.stroke, el); }
  }
  for (const st of document.querySelectorAll("svg stop")) addColor(getComputedStyle(st).stopColor, st.closest("svg"));
  const families = [...hues.entries()].filter(([, v]) => v.n >= 2);

  // chart encodings by angle / area
  const angle = [];
  for (const svg of document.querySelectorAll("svg")) {
    if (!visible(svg)) continue;
    const rings = [...svg.querySelectorAll("circle")].filter((c) => { const st = getComputedStyle(c); return st.strokeDasharray && st.strokeDasharray !== "none" && parseFloat(st.strokeWidth) >= 4; });
    const arcs = [...svg.querySelectorAll("path")].filter((p) => /[Aa]\s*[\d.]/.test(p.getAttribute("d") || ""));
    if (rings.length >= 1 || arcs.length >= 2) angle.push(box(svg, rings.length ? "donut (angle encoding)" : "pie/gauge (angle encoding)"));
  }
  for (const el of all) if (/conic-gradient\(/.test(getComputedStyle(el).backgroundImage)) angle.push(box(el, "conic ring (angle encoding)"));

  // template chrome
  const chrome = [];
  for (const el of texts) {
    const s = getComputedStyle(el), t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    const caps = s.textTransform === "uppercase" || (t.length >= 4 && /[A-Z]/.test(t) && t === t.toUpperCase() && /[A-Z]{3}/.test(t));
    if (caps && parseFloat(s.letterSpacing) >= 0.05 * parseFloat(s.fontSize) && t.length >= 3) chrome.push(box(el, "tracked all-caps eyebrow"));
  }
  for (const h of document.querySelectorAll("h1, h2")) {
    if (!visible(h)) continue;
    const hc = getComputedStyle(h).color;
    const accent = [...h.querySelectorAll("span, em, strong, b, i, mark")].find((c) => { const cs = getComputedStyle(c); return (cs.color !== hc || /gradient/.test(cs.backgroundImage)) && c.textContent.trim().length < h.textContent.trim().length * 0.6; });
    if (accent) chrome.push(box(accent, "accented headline word"));
  }
  for (const el of all) {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width >= 24 && r.width <= 64 && Math.abs(r.width - r.height) <= 4 && el.querySelector("svg, img") && !el.textContent.trim()) {
      const filled = (parse(s.backgroundColor)?.a ?? 0) > 0.05 || /gradient/.test(s.backgroundImage) || parseFloat(s.borderTopWidth) > 0;
      if (filled) chrome.push(box(el, "icon tile"));
    }
  }

  // repeated figures + numerals
  const canon = (tok) => {
    const m = /^[$€£]?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)([kKmM])?%?$/.exec(tok.replace(/[+−-]/g, ""));
    if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, "")); if (m[2]) v *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return v >= 10 || tok.includes(".") ? Math.round(v * 10) / 10 : null;
  };
  const seen = new Map();
  const numEls = [];
  for (const el of texts) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")
      .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b(,?\s*\d{4})?/g, " ")
      .replace(/\b\d{1,2}:\d{2}\b/g, " ");
    const toks = own.match(/[$€£]?[+−-]?\d[\d,.]*[kKmM]?%?/g) || [];
    for (const tok of toks) { if (/^(19|20)\d{2}[.,]?$/.test(tok)) continue; const v = canon(tok.replace(/[.,]$/, "")); if (v === null) continue; if (!seen.has(v)) seen.set(v, []); seen.get(v).push(box(el, tok)); }
    if (toks.length && own.replace(/[\s$€£%+−\-.,kKmM\d·/()→]/g, "").length <= 3) numEls.push(el);
  }
  const repeated = [...seen.entries()].filter(([, b]) => b.length >= 3);
  const tab = numEls.filter((el) => { const s = getComputedStyle(el); return /tabular-nums/.test(s.fontVariantNumeric) || /tnum/.test(s.fontFeatureSettings) || /mono/i.test(s.fontFamily); });

  // every figure on screen, for the numbers_true check (svg axis ticks that are multiples of 50 are skipped)
  const figures = [];
  for (const [v, bs] of seen.entries()) for (const b of bs) figures.push({ value: v, ...b });
  for (const t of document.querySelectorAll("svg text")) {
    const v = canon(t.textContent.trim()); if (v !== null && v % 50 === 0) for (const f of figures) if (f.value === v && f.label === t.textContent.trim()) f.tick = true;
  }

  return {
    figures: figures.filter((f) => !f.tick),
    chart_types: { count: angle.length, boxes: angle },
    template_chrome: { count: chrome.length, boxes: chrome },
    repeated_figures: { values: repeated.map(([v, b]) => ({ value: v, times: b.length })), boxes: repeated.flatMap(([, b]) => b) },
    numerals: { total: numEls.length, tabular: tab.length, boxes: numEls.filter((e) => !tab.includes(e)).map((e) => box(e, "proportional digits")) },
    contrast: { total: texts.length, failing: fails.length, boxes: fails },
    decoration: { count: deco.length, boxes: deco },
    motion: { count: motion.length, boxes: motion },
    type_scale: { sizes: [...sizes].sort((a, b) => a - b) },
    palette: { families: families.map(([bin]) => bin * 30), boxes: families.map(([bin, v]) => box(v.el, `hue ${bin * 30}°`)) },
    page: { height: document.documentElement.scrollHeight },
  };
}

const clamp = (x) => Math.max(0, Math.min(1, x));

// Numbers derivable from data.json: every leaf, sums over arrays, shares of those sums, ratios between sibling
// fields, and first→last / consecutive % changes of series. Compared after rounding to 0 or 1 decimal.
function allowedNumbers(data) {
  const out = new Set();
  const add = (v) => { if (Number.isFinite(v)) for (const x of [v, Math.round(v), Math.round(v * 10) / 10, Math.round(Math.abs(v) * 10) / 10, Math.round(v / 100) * 100]) out.add(x); };
  const walk = (o) => {
    if (typeof o === "number") return add(o);
    if (Array.isArray(o)) {
      const keys = [...new Set(o.flatMap((r) => (r && typeof r === "object" ? Object.keys(r).filter((k) => typeof r[k] === "number") : [])))];
      for (const k of keys) {
        const vals = o.map((r) => r[k]).filter((x) => typeof x === "number"); const sum = vals.reduce((a, b) => a + b, 0);
        add(sum); add(sum / vals.length); for (const v of vals) add((v / sum) * 100);
        add(((vals.at(-1) - vals[0]) / vals[0]) * 100); for (let i = 1; i < vals.length; i++) add(((vals[i] - vals[i - 1]) / vals[i - 1]) * 100);
        add(Math.max(...vals)); add(Math.min(...vals)); add(vals.at(-1) - vals[0]);
      }
      return o.forEach(walk);
    }
    if (o && typeof o === "object") {
      const nums = Object.entries(o).filter(([, v]) => typeof v === "number");
      for (const [, a] of nums) for (const [, b] of nums) if (b) add(a / b);
      Object.values(o).forEach(walk);
    }
  };
  walk(data);
  return out;
}
const score = {
  contrast: (a) => ({ normalized: a.contrast.total ? (a.contrast.total - a.contrast.failing) / a.contrast.total : 1, value: a.contrast.failing, boxes: a.contrast.boxes, rationale: `${a.contrast.total - a.contrast.failing}/${a.contrast.total} text elements pass WCAG AA` }),
  decoration: (a) => ({ normalized: clamp(1 - Math.max(0, a.decoration.count - 2) / 16), value: a.decoration.count, boxes: a.decoration.boxes, rationale: `${a.decoration.count} decorative effects (gradients, glass, glows); 2 are free` }),
  motion: (a) => ({ normalized: clamp(1 - a.motion.count / 4), value: a.motion.count, boxes: a.motion.boxes, rationale: `${a.motion.count} infinite animations` }),
  type_scale: (a) => ({ normalized: clamp(1 - (a.type_scale.sizes.length - 5) / 7), value: a.type_scale.sizes.length, boxes: [], rationale: `${a.type_scale.sizes.length} font sizes: ${a.type_scale.sizes.join(", ")} px` }),
  chart_types: (a) => ({ normalized: a.chart_types.count === 0 ? 1 : a.chart_types.count === 1 ? 0.4 : 0, value: a.chart_types.count, boxes: a.chart_types.boxes, rationale: `${a.chart_types.count} angle/area charts (donut, pie, gauge)` }),
  template_chrome: (a) => ({ normalized: clamp(1 - Math.max(0, a.template_chrome.count - 1) / 8), value: a.template_chrome.count, boxes: a.template_chrome.boxes, rationale: `${a.template_chrome.count} template habits (${[...new Set(a.template_chrome.boxes.map((b) => b.label))].join(", ") || "none"})` }),
  repeated_figures: (a) => ({ normalized: clamp(1 - a.repeated_figures.values.length / 3), value: a.repeated_figures.values.length, boxes: a.repeated_figures.boxes, rationale: a.repeated_figures.values.length ? `repeated: ${a.repeated_figures.values.map((r) => `${r.value} ×${r.times}`).join(", ")}` : "every figure shown fewer than 3 times" }),
  numerals: (a) => ({ normalized: a.numerals.total ? a.numerals.tabular / a.numerals.total : 1, value: a.numerals.total - a.numerals.tabular, boxes: a.numerals.boxes, rationale: `${a.numerals.tabular}/${a.numerals.total} numeric labels use tabular figures` }),
  numbers_true: (a, ctx) => {
    if (!ctx.data) return { normalized: 0, value: null, boxes: [], rationale: "no json evidence (data.json) to check figures against" };
    const ok = allowedNumbers(ctx.data);
    const bad = a.figures.filter((f) => !ok.has(f.value) && !ok.has(Math.round(f.value)));
    return { normalized: bad.length ? 0 : 1, value: bad.length, boxes: bad.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, label: `not in data: ${f.label}` })), rationale: bad.length ? `${bad.length} figure(s) not derivable from data.json: ${[...new Set(bad.map((f) => f.label))].slice(0, 6).join(", ")}` : `all ${a.figures.length} figures derive from data.json` };
  },
  palette: (a) => ({ normalized: clamp(1 - (a.palette.families.length - 2) / 4), value: a.palette.families.length, boxes: a.palette.boxes, rationale: `${a.palette.families.length} saturated hue families (${a.palette.families.join("°, ")}°)` }),
};

createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    const metric = /^\/audit\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
    if (req.method === "GET" && req.url?.startsWith("/raw?url=")) return reply(200, await audit(decodeURIComponent(req.url.slice(9))));
    if (req.method !== "POST" || !metric || !score[metric]) return reply(404, { error: `POST /audit/{${Object.keys(score).join("|")}}` });
    let body = ""; for await (const chunk of req) body += chunk;
    const { evidence = [] } = JSON.parse(body || "{}");
    const url = evidence.find((e) => e.kind === "url" && /^https?:/.test(e.source ?? ""))?.source;
    if (!url) return reply(400, { error: "no url evidence to render" });
    const data = evidence.find((e) => e.json !== undefined && e.kind !== "url")?.json;
    reply(200, score[metric](await audit(url), { data }));
  } catch (e) { reply(500, { error: String(e?.message ?? e) }); }
}).listen(port, "127.0.0.1", () => console.log(`ui audit scorer on http://127.0.0.1:${port}`));
