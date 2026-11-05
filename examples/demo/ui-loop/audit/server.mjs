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
    await page.waitForTimeout(400);
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

  return {
    contrast: { total: texts.length, failing: fails.length, boxes: fails },
    decoration: { count: deco.length, boxes: deco },
    motion: { count: motion.length, boxes: motion },
    type_scale: { sizes: [...sizes].sort((a, b) => a - b) },
    palette: { families: families.map(([bin]) => bin * 30), boxes: families.map(([bin, v]) => box(v.el, `hue ${bin * 30}°`)) },
    page: { height: document.documentElement.scrollHeight },
  };
}

const clamp = (x) => Math.max(0, Math.min(1, x));
const score = {
  contrast: (a) => ({ normalized: a.contrast.total ? (a.contrast.total - a.contrast.failing) / a.contrast.total : 1, value: a.contrast.failing, boxes: a.contrast.boxes, rationale: `${a.contrast.total - a.contrast.failing}/${a.contrast.total} text elements pass WCAG AA` }),
  decoration: (a) => ({ normalized: clamp(1 - Math.max(0, a.decoration.count - 2) / 16), value: a.decoration.count, boxes: a.decoration.boxes, rationale: `${a.decoration.count} decorative effects (gradients, glass, glows); 2 are free` }),
  motion: (a) => ({ normalized: clamp(1 - a.motion.count / 4), value: a.motion.count, boxes: a.motion.boxes, rationale: `${a.motion.count} infinite animations` }),
  type_scale: (a) => ({ normalized: clamp(1 - (a.type_scale.sizes.length - 5) / 7), value: a.type_scale.sizes.length, boxes: [], rationale: `${a.type_scale.sizes.length} font sizes: ${a.type_scale.sizes.join(", ")} px` }),
  palette: (a) => ({ normalized: clamp(1 - (a.palette.families.length - 2) / 4), value: a.palette.families.length, boxes: a.palette.boxes, rationale: `${a.palette.families.length} saturated hue families (${a.palette.families.join("°, ")}°)` }),
};

createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    const metric = /^\/audit\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
    if (req.method === "GET" && req.url?.startsWith("/raw?url=")) return reply(200, await audit(decodeURIComponent(req.url.slice(9))));
    if (req.method !== "POST" || !metric || !score[metric]) return reply(404, { error: "POST /audit/{contrast|decoration|motion|type_scale|palette}" });
    let body = ""; for await (const chunk of req) body += chunk;
    const { evidence = [] } = JSON.parse(body || "{}");
    const url = evidence.find((e) => e.kind === "url" && /^https?:/.test(e.source ?? ""))?.source;
    if (!url) return reply(400, { error: "no url evidence to render" });
    reply(200, score[metric](await audit(url)));
  } catch (e) { reply(500, { error: String(e?.message ?? e) }); }
}).listen(port, "127.0.0.1", () => console.log(`ui audit scorer on http://127.0.0.1:${port}`));
