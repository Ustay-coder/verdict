#!/usr/bin/env node
// Import a design system into a Verdict rubric.
//
//   node import-design-system.mjs [node_modules/@primer] [--out design-system] [--rubric design-system.yaml]
//
// Reads Primer's published tokens (@primer/primitives, light theme) and component CSS (@primer/css) and writes:
//   design-system/tokens.json    every colour, type size, weight, font stack, spacing step, radius, border width and
//                                shadow the system defines (var() references resolved)
//   design-system/primer.css     the official token variables + component CSS, for the page to link
//   design-system/specimen.png   the system's own components rendered from its stylesheet (the vision judge's reference)
//   design-system.yaml           a Verdict rubric: measured token conformance + "looks native to this system"
// The rubric's measured criteria are scored by the render-audit scorer (examples/demo/ui-loop/audit/server.mjs).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const root = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "node_modules/@primer");
const outDir = resolve(opt("out", "design-system")), rubricPath = resolve(opt("rubric", "design-system.yaml"));
const prim = join(root, "primitives"), pkg = JSON.parse(readFileSync(join(prim, "package.json"), "utf8"));
const css = (f) => readFileSync(join(prim, "dist/css", f), "utf8");

// 1. Collect custom properties and resolve var() chains.
const FILES = ["base/size/size.css", "base/typography/typography.css", "functional/size/border.css", "functional/size/radius.css",
  "functional/size/size.css", "functional/spacing/space.css", "functional/typography/typography.css", "functional/themes/light.css"];
const raw = new Map();
for (const f of FILES) for (const m of css(f).matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) raw.set(m[1], m[2].trim());
const resolveVar = (v, depth = 0) => depth > 10 ? v : v.replace(/var\(--([\w-]+)(?:,\s*([^)]+))?\)/g, (_, n, fb) => raw.has(n) ? resolveVar(raw.get(n), depth + 1) : fb ?? "");
const tok = new Map([...raw].map(([k, v]) => [k, resolveVar(v)]));
const px = (v) => { const m = /^(-?[\d.]+)(rem|px)$/.exec(v.trim()); return m ? Math.round(Number(m[1]) * (m[2] === "rem" ? 16 : 1) * 100) / 100 : null; };
const isColor = (v) => /^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v);
const pick = (re) => [...tok].filter(([k]) => re.test(k));
const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);

const SKIP = /^(prettylights|codeMirror|diffBlob|ansi|contribution|color-)/; // syntax highlighting, diffs, terminals, deprecated aliases
const colors = [...tok].filter(([k, v]) => k.match(/^[a-z]/i) && !SKIP.test(k) && isColor(v)).map(([name, value]) => ({ name, value: value.toLowerCase() }));
const tokens = {
  designSystem: { name: "Primer", package: pkg.name, version: pkg.version, theme: "light", source: "https://github.com/primer/primitives" },
  colors,
  dataColors: colors.filter((c) => /^data-.*-color-emphasis$/.test(c.name)),
  typeSizes: uniq([...pick(/^base-text-size-/), ...pick(/^text-codeBlock-size$/)].map(([, v]) => px(v)).filter((v) => v != null)),
  fontWeights: uniq(pick(/^base-text-weight-/).map(([, v]) => Number(v))),
  lineHeights: uniq(pick(/^base-text-lineHeight-/).map(([, v]) => Number(v))),
  fontStacks: { sansSerif: tok.get("fontStack-sansSerif"), monospace: tok.get("fontStack-monospace") },
  space: uniq([0, ...pick(/^base-size-/).map(([, v]) => px(v)), ...pick(/^space-/).map(([, v]) => px(v))].filter((v) => v != null)),
  radii: uniq([0, ...pick(/^borderRadius-(small|medium|large)$/).map(([, v]) => px(v))]),
  radiusFull: true,
  borderWidths: uniq([0, ...pick(/^borderWidth-(thin|thick|thicker)$/).map(([, v]) => px(v))]),
  shadows: pick(/^shadow-/).map(([name, value]) => ({ name, value })),
};

// 2. The stylesheet a page links: official variables (light) + component CSS.
mkdirSync(outDir, { recursive: true });
const primerCss = readFileSync(join(root, "css/dist/primer.css"), "utf8");
writeFileSync(join(outDir, "primer.css"), FILES.map(css).join("\n") + "\n" + primerCss);
// Component classes: the stylesheet's PascalCase components (Box, Label, UnderlineNav, …) plus its lowercase ones.
const LAYOUT = new Set(["Layout", "PageLayout", "Stack", "Truncate", "AppFrame", "AnimatedEllipsis", "DashedConnection"]);
tokens.components = [...new Set([...primerCss.matchAll(/\.([A-Z][A-Za-z]+)(?=[-.:\s{,>[)])/g)].map((m) => m[1]))].filter((c) => !LAYOUT.has(c)).sort()
  .concat(["btn", "flash", "form-control", "form-select", "tabnav", "menu", "blankslate", "pagination", "avatar"].filter((c) => primerCss.includes(`.${c}`)));
writeFileSync(join(outDir, "tokens.json"), JSON.stringify(tokens, null, 1));

// 3. Specimen: the system's own components, rendered from its own stylesheet.
const specimen = `<!doctype html><html data-color-mode="light" data-light-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="primer.css">
<style>body{padding:var(--base-size-24)} .grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--base-size-24)} .sw{display:inline-block;width:var(--base-size-24);height:var(--base-size-24);border-radius:var(--borderRadius-small)}</style></head>
<body><div class="Subhead"><h2 class="Subhead-heading">Workspace overview</h2><div class="Subhead-description">Components rendered from the design system's own stylesheet.</div></div>
<nav class="UnderlineNav mb-4"><div class="UnderlineNav-body"><a class="UnderlineNav-item selected" aria-current="page">Overview <span class="Counter">12</span></a><a class="UnderlineNav-item">Activity</a><a class="UnderlineNav-item">Members <span class="Counter">4</span></a><a class="UnderlineNav-item">Settings</a></div></nav>
<div class="grid"><div>
<div class="Box mb-4"><div class="Box-header d-flex flex-items-center"><h3 class="Box-title flex-auto">Recent items</h3><button class="btn btn-sm">View all</button></div>
<div class="Box-row d-flex flex-items-center"><span class="flex-auto">Quarterly report</span><span class="Label Label--success mr-2">Done</span><span class="color-fg-muted text-small">2 days ago</span></div>
<div class="Box-row d-flex flex-items-center"><span class="flex-auto">Invoice batch</span><span class="Label Label--attention mr-2">Pending</span><span class="color-fg-muted text-small">5 hours ago</span></div>
<div class="Box-row d-flex flex-items-center"><span class="flex-auto">Account review</span><span class="Label Label--danger mr-2">Overdue</span><span class="color-fg-muted text-small">1 week ago</span></div>
<div class="Box-row d-flex flex-items-center"><span class="flex-auto">Data export</span><span class="Label Label--secondary mr-2">Draft</span><span class="color-fg-muted text-small">just now</span></div></div>
<div class="flash flash-warn mb-2">A warning message with a <a href="#">link</a>.</div><div class="flash flash-error mb-2">An error message.</div><div class="flash flash-success">A success message.</div>
</div><div>
<div class="Box mb-4"><div class="Box-header"><h3 class="Box-title">Usage</h3></div><div class="Box-body">
<div class="d-flex flex-justify-between mb-1"><span class="text-bold">Storage</span><span class="color-fg-muted">68%</span></div><span class="Progress mb-3"><span class="Progress-item color-bg-accent-emphasis" style="width:68%"></span></span>
<div class="d-flex flex-justify-between mb-1"><span class="text-bold">Seats</span><span class="color-fg-muted">41 of 50</span></div><span class="Progress"><span class="Progress-item color-bg-success-emphasis" style="width:82%"></span></span></div></div>
<div class="d-flex mb-4" style="gap:var(--base-size-8)"><button class="btn btn-primary">Primary</button><button class="btn">Secondary</button><button class="btn btn-danger">Danger</button><button class="btn btn-invisible">Invisible</button></div>
<div class="d-flex mb-4" style="gap:var(--base-size-8)"><input class="form-control flex-auto" placeholder="Filter"><select class="form-select"><option>Last 30 days</option></select></div>
<div class="mb-2"><span class="f1 text-semibold">32</span> <span class="f2">24</span> <span class="f3">20</span> <span class="f4">16</span> <span class="f5">14</span> <span class="f6">12</span></div>
<div>${tokens.dataColors.map((c) => `<span class="sw" style="background:${c.value}"></span>`).join(" ")}</div>
</div></div></body></html>`;
writeFileSync(join(outDir, "specimen.html"), specimen);
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("file://" + join(outDir, "specimen.html"), { waitUntil: "load" });
await page.screenshot({ path: join(outDir, "specimen.png") });
await browser.close();

// 4. The rubric.
const T = tokens, ds = `${T.designSystem.name} ${T.designSystem.version}`;
const keyColors = ["fgColor-default", "fgColor-muted", "fgColor-accent", "bgColor-default", "bgColor-muted", "borderColor-default", "fgColor-success", "fgColor-attention", "fgColor-danger"]
  .map((n) => `${n} ${T.colors.find((c) => c.name === n)?.value}`).join(", ");
const yaml = `# Generated by import-design-system.mjs from ${T.designSystem.package}@${T.designSystem.version} (${T.designSystem.theme} theme). Don't edit by hand.
# Does the page follow the ${T.designSystem.name} design system? Measured against its tokens, judged against its own components.
# Inputs: -i ui=<page url> --screenshot  -i ds=design-system/tokens.json  -i specimen=design-system/specimen.png  -i data=data.json
# Needs the render-audit scorer: node examples/demo/ui-loop/audit/server.mjs (port 7788).
name: ${T.designSystem.name} design system
version: "${T.designSystem.version}"
description: Is this page built with ${ds}, measured against its tokens and judged against its own components?
context: |
  You review a product screen against the ${ds} design system (${T.designSystem.theme} theme). Its tokens:
  ${T.colors.length} colours (key: ${keyColors}); categorical data colours ${T.dataColors.map((c) => c.value).join(" ")};
  type sizes ${T.typeSizes.join("/")} px in weights ${T.fontWeights.join("/")}; spacing ${T.space.filter((v) => v > 0 && v <= 48).join("/")} px;
  radii ${T.radii.filter(Boolean).join("/")} px; 1 px borders in borderColor-default; flat surfaces with almost no shadow.
  When two images are attached, the first is the screen under review and the second is a specimen of ${T.designSystem.name}'s own
  components (Box, Subhead, UnderlineNav, Label, Button, flash, Progress) rendered from its official stylesheet.
language: en
scale: { type: numeric, min: 1, max: 5 }

judges:
  clef: { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef" }
defaultJudge: { type: ref, ref: clef }

criteria:
  # ---------- looks native (Clef sees the screenshot next to the specimen) ----------
  - id: native
    name: Looks native to ${T.designSystem.name}
    group: Look
    weight: 3
    inputs: [ui, specimen]
    levels:
      - { value: 1, label: foreign, description: "A different visual language from the specimen: other surfaces, colours, type or shapes" }
      - { value: 3, label: borrowed, description: "Borrows the specimen's colours, but its components, density or surfaces don't match" }
      - { value: 5, label: native, description: "Could ship inside the product the specimen comes from: same surfaces, borders, type, labels and density" }
  - id: surfaces
    name: Surfaces match the specimen
    group: Look
    weight: 2
    inputs: [ui, specimen]
    levels:
      - { value: 1, label: different, description: "Backgrounds, panels and borders look unlike the specimen (dark, glowing, glassy or heavy shadows)" }
      - { value: 3, label: close, description: "Light panels like the specimen, but with other borders, radii, shadows or colours" }
      - { value: 5, label: identical, description: "White panels with thin grey borders and small radii, grey header strips, flat like the specimen" }
  - id: craft
    name: Composed with care
    group: Look
    weight: 2
    inputs: [ui]
    levels:
      - { value: 1, label: unstyled, description: "Default browser look or a pile of parts; no visible layout system" }
      - { value: 3, label: uneven, description: "Competent but uneven: inconsistent alignment, spacing or emphasis" }
      - { value: 5, label: crafted, description: "Aligned grid, consistent rhythm, a clear reading order and one obvious focal point" }

  # ---------- measured against the tokens (render-audit scorer reads design-system/tokens.json) ----------
  - { id: ds_color, name: "Colours are ${T.designSystem.name} tokens", group: Tokens, weight: 1, inputs: [ui, ds], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/ds_color" } }
  - { id: ds_type, name: "Type sizes, weights and faces are on the scale", group: Tokens, weight: 1, inputs: [ui, ds], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/ds_type" } }
  - { id: ds_space, name: "Spacing is on the scale", group: Tokens, weight: 1, inputs: [ui, ds], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/ds_space" } }
  - { id: ds_components, name: "Panels, labels and controls are ${T.designSystem.name} components", group: Tokens, weight: 1, inputs: [ui, ds], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/ds_components" } }
  - { id: ds_shape, name: "Radii, borders and shadows are tokens", group: Tokens, weight: 1, inputs: [ui, ds], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/ds_shape" } }
  - { id: contrast, name: Text passes WCAG AA, group: Tokens, weight: 1, inputs: [ui], judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/contrast" } }
  - id: numbers_true
    name: Every figure derives from data.json
    group: Data
    weight: 0
    inputs: [ui, data]
    scale: { type: binary, labels: [no, yes] }
    judge: { type: benchmark, method: http, url: "http://127.0.0.1:7788/audit/numbers_true" }

aggregation:
  # Looking native earns the points; off-token values take them away.
  method: formula
  formula: "(native_n * 3 + surfaces_n * 2 + craft_n * 2) / 7 * (0.4 + 0.6 * (ds_color_n + ds_type_n + ds_space_n + ds_shape_n + ds_components_n + contrast_n) / 6)"
  normalize: [0, 100]
  precision: 0
  gates:
    - { criterion: numbers_true, min: 1, message: "A figure on the page doesn't match data.json" }
    - { criterion: native, min: 3, message: "Doesn't look like ${T.designSystem.name}" }
  grades: [{ label: ship it, min: 85 }, { label: almost, min: 65 }, { label: rework, min: 0 }]
  passThreshold: 85
`;
writeFileSync(rubricPath, yaml);
console.log(`${ds} (${T.designSystem.theme}): ${T.colors.length} colours (${T.dataColors.length} for data), type ${T.typeSizes.join("/")} px, weights ${T.fontWeights.join("/")}, ` +
  `${T.space.length} spacing steps, radii ${T.radii.filter(Boolean).join("/")} px + full, ${T.shadows.length} shadows`);
console.log(`→ ${[join(outDir, "tokens.json"), join(outDir, "primer.css"), join(outDir, "specimen.png"), rubricPath].map((p) => p.replace(process.cwd() + "/", "")).join(", ")}`);
