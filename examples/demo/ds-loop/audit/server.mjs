#!/usr/bin/env node
// Render-audit scorer for Verdict's `http` benchmark judge.
//
//   node examples/demo/ds-loop/audit/server.mjs [port=7788]
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
//   template_chrome  tracked all-caps eyebrows, accented headline words, icon tiles, one-edge accent bars,
//               numbered section headings, Inter as the face that actually renders (CDP getPlatformFontsForNode)
//   repeated_figures the same figure shown 3+ times (48.2k and $48,200 count as the same value)
//   numerals    share of numeric text set with tabular figures (or a monospace face)
//   numbers_true every figure on screen derives from the json evidence (data.json): leaves, sums, shares, ratios, % changes
// Design-system conformance (needs a `ds` input: tokens.json from the Primer importer, in git history before video B v2):
//   ds_color    share of colour uses (text, backgrounds, borders, SVG fills/strokes) that are token colours; gradients
//               and canvas count as off-token; off-token colours come back with the nearest token
//   ds_type     share of text styles whose size and weight are on the scale (70%) and of glyphs set in the faces the
//               system's font stacks render (30%)
//   ds_space    share of spacing values on the scale: padding + border per side, margins (not auto), flex/grid gaps
//   ds_components share of elements that draw a box of their own (bordered or filled panels, badges, buttons, inputs,
//               bars) that are the system's components (carry one of its component classes); a class that looks like
//               the system's but that no stylesheet defines (e.g. a utility from another version) counts as broken
//   ds_shape    share of radii (token or full), border widths and box shadows (exact token shadows) that are tokens
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
    result.fonts.rendered = await renderedFonts(page);
    result.styles = await page.evaluate(collectStyles);
    if (result.fonts.rendered[0] && /^inter( display)?$/i.test(result.fonts.rendered[0].family) && result.fonts.rendered[0].share > 0.5) {
      result.template_chrome.boxes.push({ x: 0, y: 0, w: 0, h: 0, label: `default AI font (Inter renders ${Math.round(result.fonts.rendered[0].share * 100)}% of glyphs)` });
      result.template_chrome.count++;
    }
    cache.set(key, result);
    return result;
  } finally { await page.close(); }
}

// The faces Chromium actually used (declared stacks lie when a font isn't installed), by share of glyphs.
async function renderedFonts(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "body *" });
  const glyphs = new Map();
  for (const nodeId of nodeIds.slice(0, 400)) {
    try {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const f of fonts) glyphs.set(f.familyName, (glyphs.get(f.familyName) ?? 0) + f.glyphCount);
    } catch { /* node without layout */ }
  }
  await cdp.detach();
  const total = [...glyphs.values()].reduce((a, b) => a + b, 0) || 1;
  return [...glyphs.entries()].sort((a, b) => b[1] - a[1]).map(([family, n]) => ({ family, share: Math.round((n / total) * 100) / 100 }));
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
  // `at` names the element for rationales: tag, first classes and the start of its text
  const where = (el) => { const cls = [...(el.classList ?? [])].slice(0, 2).map((c) => "." + c).join(""); const t = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 36); return `<${el.tagName.toLowerCase()}${cls}>${t ? ` "${t}${(el.textContent ?? "").trim().length > 36 ? "…" : ""}"` : ""}`; };
  const box = (el, label) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), label, at: where(el) }; };
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
    const bg = bgOf(clipText ? el.parentElement || el : el); // its own background counts (buttons, chips), unless it paints the text
    const fgc = over({ ...fg, a: fg.a * Number(s.opacity) }, bg);
    const [L1, L2] = [lum(fgc), lum(bg)].sort((a, b) => b - a);
    const ratio = (L1 + 0.05) / (L2 + 0.05);
    const px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) { const hx = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""); fails.push(box(el, `contrast ${ratio.toFixed(2)}:1 (${hx(fgc)} on ${hx(bg)}, needs ${large ? 3 : 4.5})`)); }
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

  // one-edge accent bars: a thick coloured border on one side only (a catalogued AI habit)
  for (const el of all) {
    const s = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({ k, w: parseFloat(s[`border${k}Width`]) || 0, c: parse(s[`border${k}Color`]) }));
    const thick = sides.filter((x) => x.w >= 3 && x.c && x.c.a > 0.3), thin = sides.filter((x) => x.w <= 1);
    const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    if (thick.length === 1 && thin.length === 3 && sat(thick[0].c) > 40 && el.getBoundingClientRect().height > 40) chrome.push(box(el, `one-edge accent bar (${thick[0].k.toLowerCase()})`));
  }
  // numbered section markers: headings that start "1." / "01" / "Step 1"
  for (const h of document.querySelectorAll("h1, h2, h3, h4, [role=heading]")) {
    if (visible(h) && /^\s*(step\s*)?0?\d{1,2}[.):·\s—–-]\s*\S/i.test(h.textContent)) chrome.push(box(h, "numbered section heading"));
  }
  // default font: the face that actually renders body text
  const bodyFont = getComputedStyle(document.body).fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const usedFonts = [...new Set(texts.map((el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim()))];

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
    fonts: { body: bodyFont, used: usedFonts },
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

const named = (boxes, n = 8) => (boxes.length ? `; ${boxes.slice(0, n).map((b) => (b.at ? `${b.label} at ${b.at}` : b.label)).join("; ")}${boxes.length > n ? `; +${boxes.length - n} more` : ""}` : "");
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

// Runs in the page: every colour, type, spacing and shape value the page actually uses (for design-system conformance).
function collectStyles() {
  const out = [];
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0; };
  const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return 0; const p = m[1].split(/[,\s/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
  const px = (v) => (v && v.endsWith("px") ? Number(v.slice(0, -2)) : null);
  const keyword = (el, prop) => { try { const v = el.computedStyleMap().get(prop); return v && v.constructor.name === "CSSKeywordValue" ? String(v) : null; } catch { return null; } };
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll("*")];
  for (const el of els) {
    if (/^(SCRIPT|STYLE|LINK|META|TITLE|HEAD|BR|DEFS|LINEARGRADIENT|RADIALGRADIENT|STOP|CLIPPATH|MASK|FILTER)$/i.test(el.tagName) || !visible(el)) continue;
    const cs = getComputedStyle(el), b = box(el), inSvg = el instanceof SVGElement;
    if (inSvg) {
      if (el.tagName.toLowerCase() === "svg") continue;
      for (const prop of ["fill", "stroke"]) {
        const v = cs[prop];
        if (!v || v === "none" || (prop === "stroke" && (px(cs.strokeWidth) ?? 1) === 0)) continue;
        if (/url\(/.test(v)) out.push({ k: "color", prop, gradient: true, b });
        else if (alpha(v) > 0) out.push({ k: "color", prop, value: v, b });
      }
      if (el.tagName.toLowerCase() === "text" && el.textContent.trim()) out.push({ k: "text", size: px(cs.fontSize), weight: Number(cs.fontWeight), b });
      continue;
    }
    if (el.tagName === "CANVAS") { out.push({ k: "color", prop: "canvas", unknown: true, b }); continue; }
    // Component-like elements (panels, badges, buttons, inputs, bars): anything that draws a box of its own.
    if (el !== document.documentElement && el !== document.body) {
      const bordered = ["Top", "Right", "Bottom", "Left"].some((d) => cs[`border${d}Style`] !== "none" && (px(cs[`border${d}Width`]) ?? 0) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
      const parentBg = (() => { for (let p = el.parentElement; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (alpha(c) > 0) return c; } return "rgb(255, 255, 255)"; })();
      const filled = alpha(cs.backgroundColor) > 0 && cs.backgroundColor !== parentBg;
      const control = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
      const huge = b.w >= innerWidth * 0.9 && b.h >= document.documentElement.scrollHeight * 0.8;
      const cell = /^(TD|TH|TR|THEAD|TBODY|TABLE)$/.test(el.tagName) && !filled; // table rules are content structure, not components
      if ((bordered || filled || control) && !huge && !cell) out.push({ k: "part", classes: [...el.classList], tag: el.tagName.toLowerCase(), b });
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) { out.push({ k: "text", size: px(cs.fontSize), weight: Number(cs.fontWeight), b }); out.push({ k: "color", prop: "color", value: cs.color, b }); }
    for (const pseudo of [null, "::before", "::after"]) {
      const ps = pseudo ? getComputedStyle(el, pseudo) : cs;
      if (pseudo && (ps.content === "none" || ps.content === "normal" || ps.display === "none")) continue;
      if (alpha(ps.backgroundColor) > 0) out.push({ k: "color", prop: "background" + (pseudo ?? ""), value: ps.backgroundColor, b });
      if (/gradient\(/.test(ps.backgroundImage)) out.push({ k: "color", prop: "background-image" + (pseudo ?? ""), gradient: ps.backgroundImage, b });
      const sides = ["Top", "Right", "Bottom", "Left"].filter((d) => ps[`border${d}Style`] !== "none" && (px(ps[`border${d}Width`]) ?? 0) > 0);
      for (const v of new Set(sides.map((d) => ps[`border${d}Color`]))) if (alpha(v) > 0) out.push({ k: "color", prop: "border" + (pseudo ?? ""), value: v, b });
      for (const v of new Set(sides.map((d) => px(ps[`border${d}Width`])))) out.push({ k: "borderWidth", value: v, b });
      const radii = new Set(["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map((c) => px(ps[`border${c}Radius`])).filter((v) => v > 0));
      for (const v of radii) out.push({ k: "radius", value: v, b });
      if (ps.boxShadow && ps.boxShadow !== "none") out.push({ k: "shadow", value: ps.boxShadow, b });
      if (pseudo) continue;
      for (const d of ["Top", "Right", "Bottom", "Left"]) {
        const inset = (px(cs[`padding${d}`]) ?? 0) + (sides.includes(d) ? px(cs[`border${d}Width`]) : 0);
        if (inset > 0) out.push({ k: "space", prop: `inset-${d.toLowerCase()}`, value: Math.round(inset * 100) / 100, pad: px(cs[`padding${d}`]), b });
        const m = px(cs[`margin${d}`]);
        if (m && !keyword(el, `margin-${d.toLowerCase()}`)) out.push({ k: "space", prop: `margin-${d.toLowerCase()}`, value: Math.round(m * 100) / 100, b });
      }
      for (const g of ["rowGap", "columnGap"]) { const v = px(cs[g]); if (v > 0 && /flex|grid/.test(cs.display)) out.push({ k: "space", prop: g, value: v, b }); }
    }
  }
  // Classes the page uses that no stylesheet defines but that look like the system's (same prefix as a defined class):
  // a misremembered utility (color-bg-neutral-emphasis in a version without it) silently paints nothing.
  const defined = new Set();
  const walk = (rules) => { for (const r of rules) { if (r.selectorText) for (const m of r.selectorText.matchAll(/\.([\w-]+)/g)) defined.add(m[1]); if (r.cssRules) walk(r.cssRules); } };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch { /* cross-origin */ } }
  const prefixes = new Set([...defined].map((c) => c.split("-")[0]));
  let n = 0; // every element using one counts: seven bars painted with an undefined class are seven broken bars
  for (const el of document.querySelectorAll("[class]")) for (const c of el.classList) {
    if (defined.has(c) || !c.includes("-") || !prefixes.has(c.split("-")[0]) || !visible(el) || ++n > 60) continue;
    out.push({ k: "unknownClass", value: c, b: box(el) });
  }
  return out;
}

// Design-system conformance: compare the values the page uses with the tokens in the `ds` input (tokens.json).
const hexRgba = (h) => { h = h.replace("#", ""); if (h.length <= 4) h = [...h].map((c) => c + c).join(""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }; };
const cssRgba = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
const toColor = (v) => (v.startsWith("#") ? hexRgba(v) : cssRgba(v));
const hex = ({ r, g, b, a }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") + (a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : "");
const near = (x, y, tol = 0.5) => Math.abs(x - y) <= tol;
const dsCache = new WeakMap();
function dsIndex(ds) {
  if (dsCache.has(ds)) return dsCache.get(ds);
  const colors = ds.colors.map((c) => ({ ...c, rgba: toColor(c.value) })).filter((c) => c.rgba);
  const layers = (v) => v.split(/,(?![^(]*\))/).map((l) => { const c = /(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i.exec(l)?.[0]; const nums = [...l.replace(c ?? "", "").matchAll(/-?[\d.]+(px|rem)?/g)].map((m) => Number(m[0].replace(/px|rem/, "")) * (m[0].endsWith("rem") ? 16 : 1)); return { inset: /inset/.test(l), color: c ? toColor(c) : null, nums: [...nums, 0, 0, 0, 0].slice(0, 4) }; });
  const shadows = ds.shadows.map((s) => ({ ...s, layers: layers(s.value) }));
  const idx = { colors, shadows, layers };
  dsCache.set(ds, idx); return idx;
}
const colorMatch = (idx, rgba) => idx.colors.find((c) => near(c.rgba.r, rgba.r, 2) && near(c.rgba.g, rgba.g, 2) && near(c.rgba.b, rgba.b, 2) && near(c.rgba.a, rgba.a, 0.02));
const nearestColor = (idx, rgba) => idx.colors.filter((c) => near(c.rgba.a, rgba.a, 0.05)).sort((x, y) => dist(x.rgba, rgba) - dist(y.rgba, rgba))[0];
const dist = (p, q) => (p.r - q.r) ** 2 + (p.g - q.g) ** 2 + (p.b - q.b) ** 2;
const hairline = (idx, dsT, v) => idx.layers(v).every((l) => l.inset && l.nums[2] === 0 && l.color && colorMatch(idx, l.color) && l.nums.slice(0, 2).concat(l.nums[3]).every((n) => n === 0 || dsT.borderWidths.includes(Math.abs(n))));
const shadowMatch = (idx, v) => { const L = idx.layers(v); return idx.shadows.find((s) => s.layers.length === L.length && s.layers.every((t, i) => t.inset === L[i].inset && t.nums.every((n, j) => near(n, L[i].nums[j], 0.5)) && (!t.color || (L[i].color && dist(t.color, L[i].color) <= 12 && near(t.color.a, L[i].color.a, 0.02))))); };
const tally = (items) => { const m = new Map(); for (const it of items) { const e = m.get(it.key) ?? { ...it, n: 0, boxes: [] }; e.n++; if (e.boxes.length < 6) e.boxes.push(it.b); m.set(it.key, e); } return [...m.values()].sort((a, b) => b.n - a.n); };
const report = (total, off, what, fmt) => {
  const t = tally(off), share = total ? (total - off.length) / total : 1;
  return { normalized: Math.round(share * 1000) / 1000, value: off.length, boxes: t.flatMap((e) => e.boxes.map((b) => ({ ...b, label: e.key }))).slice(0, 80),
    rationale: `${total - off.length}/${total} ${what} are tokens (${Math.round(share * 100)}%)` + (t.length ? `; off-token: ${t.slice(0, 8).map(fmt).join("; ")}` : "") };
};
const rendersAs = new Map();
async function renderedFace(stack) {
  if (rendersAs.has(stack)) return rendersAs.get(stack);
  const page = await browser.newPage();
  try { await page.setContent(`<p style='font-family:${stack.replace(/'/g, "")}'>Abc 123</p>`); const f = (await renderedFonts(page))[0]?.family; rendersAs.set(stack, f); return f; } finally { await page.close(); }
}
const ds = {
  ds_color: (a, idx) => {
    const uses = a.styles.filter((u) => u.k === "color");
    const off = [];
    for (const u of uses) {
      if (u.gradient) {
        // A gradient between identical token colours is a flat fill (the system's own flash banners do this).
        const stops = typeof u.gradient === "string" ? [...u.gradient.matchAll(/rgba?\([^)]+\)/g)].map((m) => cssRgba(m[0])) : [];
        const flat = stops.length && stops.every((c) => dist(c, stops[0]) === 0 && c.a === stops[0].a) && colorMatch(idx, stops[0]);
        if (!flat) off.push({ key: `gradient (${u.prop})`, b: u.b });
        continue;
      }
      if (u.unknown) { off.push({ key: "canvas (colours can't be checked)", b: u.b }); continue; }
      const c = cssRgba(u.value); if (!c || colorMatch(idx, c)) continue;
      const n = nearestColor(idx, c); off.push({ key: hex(c), hint: n ? `${n.name} ${n.value}` : "", b: u.b });
    }
    return report(uses.length, off, "colour uses", (e) => `${e.key} ×${e.n}${e.hint ? ` (nearest token: ${e.hint})` : ""}`);
  },
  ds_type: async (a, idx, dsT) => {
    const texts = a.styles.filter((u) => u.k === "text");
    const off = [];
    for (const t of texts) {
      const s = dsT.typeSizes.some((v) => near(v, t.size, 0.25)), w = dsT.fontWeights.includes(t.weight);
      if (!s || !w) off.push({ key: `${!s ? `${t.size}px` : ""}${!s && !w ? " " : ""}${!w ? `weight ${t.weight}` : ""}`, b: t.b });
    }
    const faces = new Set([await renderedFace(dsT.fontStacks.sansSerif), await renderedFace(dsT.fontStacks.monospace)].filter(Boolean));
    const inFace = (fam) => [...faces].some((f) => fam === f || fam.startsWith(f + " "));
    const faceShare = a.fonts.rendered.filter((f) => inFace(f.family)).reduce((s, f) => s + f.share, 0);
    const r = report(texts.length, off, "text styles", (e) => `${e.key} ×${e.n}`);
    const n = Math.round((0.7 * r.normalized + 0.3 * Math.min(1, faceShare)) * 1000) / 1000;
    const foreign = a.fonts.rendered.filter((f) => !inFace(f.family) && f.share >= 0.02).map((f) => `${f.family} ${Math.round(f.share * 100)}%`);
    return { ...r, normalized: n, rationale: r.rationale + `; ${Math.round(Math.min(1, faceShare) * 100)}% of glyphs in the system's faces (${[...faces].join(", ")})` + (foreign.length ? `, other faces: ${foreign.join(", ")}` : "") + `. Scale: ${dsT.typeSizes.join("/")} px, weights ${dsT.fontWeights.join("/")}` };
  },
  ds_space: (a, idx, dsT) => {
    const uses = a.styles.filter((u) => u.k === "space");
    // An inset is on the scale if the padding is, or padding + border is (a 16px row under a 1px rule, a 6px button inset).
    // Hairline offsets (±1–2px margins that overlap borders) are border widths, not spacing.
    const onScale = (v) => dsT.space.some((t) => near(Math.abs(v), t));
    const off = uses.filter((u) => !(onScale(u.value) || (u.pad != null && onScale(u.pad)) || (u.prop.startsWith("margin") && dsT.borderWidths.includes(Math.abs(u.value)))))
      .map((u) => ({ key: `${u.value}px`, b: u.b, prop: u.prop }));
    return { ...report(uses.length, off, "spacing values (padding + border, margin, gap)", (e) => `${e.key} ×${e.n}`), rationale: report(uses.length, off, "spacing values (padding + border, margin, gap)", (e) => `${e.key} ×${e.n}`).rationale + `. Scale: ${dsT.space.filter((v) => v <= 64).join("/")} px` };
  },
  ds_components: (a, idx, dsT) => {
    const parts = a.styles.filter((u) => u.k === "part");
    const roots = dsT.components ?? [];
    const isDs = (c) => roots.some((r) => c === r || c.startsWith(r + "-"));
    const off = parts.filter((u) => !u.classes.some(isDs)).map((u) => ({ key: `custom ${u.tag}${u.classes.length ? "." + u.classes.slice(0, 2).join(".") : ""}`, b: u.b }));
    // Each class the system doesn't define counts as a broken part: it renders as nothing.
    const unknown = a.styles.filter((u) => u.k === "unknownClass").map((u) => ({ key: `.${u.value} is not defined by the stylesheet`, b: u.b }));
    const r = report(parts.length + unknown.length, [...unknown, ...off], "panels, badges, buttons, inputs and bars", (e) => `${e.key} ×${e.n}`);
    return { ...r, rationale: r.rationale.replace(" are tokens", ` are ${dsT.designSystem.name} components`) + `. Components: ${roots.join(", ")}` };
  },
  ds_shape: (a, idx, dsT) => {
    const uses = a.styles.filter((u) => u.k === "radius" || u.k === "borderWidth" || u.k === "shadow");
    const off = [];
    for (const u of uses) {
      if (u.k === "radius" && !(dsT.radii.some((v) => near(v, u.value)) || (dsT.radiusFull && u.value >= Math.min(u.b.w, u.b.h) / 2 - 0.5))) off.push({ key: `radius ${u.value}px`, b: u.b });
      if (u.k === "borderWidth" && !dsT.borderWidths.some((v) => near(v, u.value, 0.1))) off.push({ key: `border ${u.value}px`, b: u.b });
      if (u.k === "shadow" && !shadowMatch(idx, u.value) && !hairline(idx, dsT, u.value)) off.push({ key: `shadow ${u.value.slice(0, 60)}`, b: u.b });
    }
    return { ...report(uses.length, off, "radii, border widths and shadows", (e) => `${e.key} ×${e.n}`), rationale: report(uses.length, off, "radii, border widths and shadows", (e) => `${e.key} ×${e.n}`).rationale + `. Radii ${dsT.radii.filter(Boolean).join("/")} px or full; borders ${dsT.borderWidths.filter(Boolean).join("/")} px; shadows: ${dsT.shadows.map((x) => x.name).join(", ")}` };
  },
};

const score = {
  contrast: (a) => ({ normalized: a.contrast.total ? (a.contrast.total - a.contrast.failing) / a.contrast.total : 1, value: a.contrast.failing, boxes: a.contrast.boxes, rationale: `${a.contrast.total - a.contrast.failing}/${a.contrast.total} text elements pass WCAG AA${named(a.contrast.boxes)}` }),
  decoration: (a) => ({ normalized: clamp(1 - Math.max(0, a.decoration.count - 2) / 16), value: a.decoration.count, boxes: a.decoration.boxes, rationale: `${a.decoration.count} decorative effects (gradients, glass, glows); 2 are free${named(a.decoration.boxes)}` }),
  motion: (a) => ({ normalized: clamp(1 - a.motion.count / 4), value: a.motion.count, boxes: a.motion.boxes, rationale: `${a.motion.count} infinite animations${named(a.motion.boxes)}` }),
  type_scale: (a) => ({ normalized: clamp(1 - (a.type_scale.sizes.length - 5) / 7), value: a.type_scale.sizes.length, boxes: [], rationale: `${a.type_scale.sizes.length} font sizes: ${a.type_scale.sizes.join(", ")} px` }),
  chart_types: (a) => ({ normalized: a.chart_types.count === 0 ? 1 : a.chart_types.count === 1 ? 0.4 : 0, value: a.chart_types.count, boxes: a.chart_types.boxes, rationale: `${a.chart_types.count} angle/area charts (donut, pie, gauge)` }),
  template_chrome: (a) => ({ normalized: clamp(1 - Math.max(0, a.template_chrome.count - 1) / 8), value: a.template_chrome.count, boxes: a.template_chrome.boxes, rationale: `${a.template_chrome.count} template habits (1 is free)${named(a.template_chrome.boxes)}` }),
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
    if (req.method !== "POST" || !metric || !(score[metric] || ds[metric])) return reply(404, { error: `POST /audit/{${[...Object.keys(score), ...Object.keys(ds)].join("|")}}` });
    let body = ""; for await (const chunk of req) body += chunk;
    const { evidence = [] } = JSON.parse(body || "{}");
    const url = evidence.find((e) => e.kind === "url" && /^https?:/.test(e.source ?? ""))?.source;
    if (!url) return reply(400, { error: "no url evidence to render" });
    const dsT = evidence.find((e) => e.json?.designSystem)?.json;
    const data = evidence.find((e) => e.json !== undefined && e.kind !== "url" && !e.json?.designSystem)?.json;
    if (ds[metric]) {
      if (!dsT) return reply(400, { error: "no design-system tokens (tokens.json with a designSystem key) in the evidence" });
      return reply(200, await ds[metric](await audit(url), dsIndex(dsT), dsT));
    }
    reply(200, score[metric](await audit(url), { data }));
  } catch (e) { reply(500, { error: String(e?.message ?? e) }); }
}).listen(port, "127.0.0.1", () => console.log(`ui audit scorer on http://127.0.0.1:${port}`));
