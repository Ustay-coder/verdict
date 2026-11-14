#!/usr/bin/env node
// Plant one known defect at a time in the round-6 page (80/100, passed) and write the cases for `verdict run`.
//
//   node make-variants.mjs
//
// Each variant is the round-6 page with exactly the edits listed below, made by this script and not by a model, so
// nothing else changes. `expected` is the truth for the six gates: what a person checking the page would decide.
// Screenshots (desktop 1280×800, phone 390×844, first screen) are taken the way run.mjs takes them.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = readFileSync(join(here, "../rounds/r06/index.html"), "utf8");
const PASS = { says_what: "pass", cta_visible: "pass", cta_real: "pass", no_fabrication: "pass", no_placeholder: "pass", mobile_ok: "pass" };
const FOR = '<p class="for">';
const AFTER_FOR = "those</em> right.</p>"; // the end of the hero's "Built for" line, just above its install command
const STYLE_END = "</style>";

// [from, to, count]: `from` must occur exactly `count` times (all are replaced); anything else is an error.
const variants = [
  { id: "v0", defect: "None (the round-6 page as it passed)", edits: [], fails: [] },
  { id: "v1", defect: "An invented testimonial on the first screen", fails: ["no_fabrication"],
    edits: [[FOR, '<blockquote class="for">“Verdict cut our eval time in half.” <span>— Head of ML, a fintech startup</span></blockquote>\n      ' + FOR, 1]] },
  { id: "v2", defect: "An invented user count on the first screen", fails: ["no_fabrication"],
    edits: [[FOR, '<p class="for"><span>Trusted by</span> 1,200+ engineering teams.</p>\n      ' + FOR, 1]] },
  { id: "v3", defect: "The real run's best result inflated: Clef-flash 73/80 (91%) shown as 79/80 (99%)", fails: ["no_fabrication"],
    edits: [["73/80 <small>91%</small>", "79/80 <small>99%</small>", 1], ['style="width:91%"', 'style="width:99%"', 1], ["73/80 (91%)", "79/80 (99%)", 1]] },
  { id: "v4", defect: "A wrong package name in every install command (@verdict/cli)", fails: ["cta_real"],
    edits: [["@verdict-ai/cli", "@verdict/cli", 8]] },
  { id: "v5", defect: "Every repository link points to a repository that does not exist (verdict-cli)", fails: ["cta_real"],
    edits: [["github.com/Ustay-coder/verdict", "github.com/Ustay-coder/verdict-cli", 11]] },
  { id: "v6", defect: "The first-screen install command and button drawn in the background colour", fails: ["cta_visible"],
    edits: [[STYLE_END, ".hero .cta,.hero .cta *{color:var(--bg)!important;background:var(--bg)!important;border-color:var(--bg)!important}\n" + STYLE_END, 1]] },
  { id: "v7", defect: "The page is 960px wide on a phone and overflows sideways", fails: ["mobile_ok"],
    edits: [[STYLE_END, "body{min-width:960px}\n" + STYLE_END, 1]] },
  { id: "v8", defect: "An unfilled slot on the first screen: [Insert demo GIF here]", fails: ["no_placeholder"],
    edits: [[AFTER_FOR, AFTER_FOR + '\n      <div class="for" style="border:2px dashed currentColor;padding:28px;text-align:center">[Insert demo GIF here]</div>', 1]] },
  { id: "v9", defect: "None a person would block: the logo links back to the top with href=\"#\"", fails: [],
    edits: [['href="#top"', 'href="#"', 2]] },
];

function apply(html, edits) {
  for (const [from, to, count] of edits) {
    const found = html.split(from).length - 1;
    if (found !== count) throw new Error(`expected ${count} × ${JSON.stringify(from)}, found ${found}`);
    html = html.split(from).join(to);
  }
  return html;
}

const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
const cases = [];
try {
  for (const v of variants) {
    const dir = join(here, "variants", v.id);
    mkdirSync(dir, { recursive: true });
    const html = apply(base, v.edits);
    writeFileSync(join(dir, "index.html"), html);
    copyFileSync(join(dir, "index.html"), join(dir, "source.txt"));
    for (const [name, viewport] of [["desktop.png", { width: 1280, height: 800 }], ["mobile.png", { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
      await page.goto(`file://${join(dir, "index.html")}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(dir, name) });
      await page.close();
    }
    const expected = { ...PASS };
    for (const gate of v.fails) expected[gate] = "fail";
    const at = (f) => `variants/${v.id}/${f}`;
    cases.push({ id: v.id, name: v.defect, expected, inputs: [
      { type: "image", path: at("desktop.png"), tags: ["desktop"] },
      { type: "image", path: at("mobile.png"), tags: ["mobile"] },
      { type: "file", path: at("index.html"), tags: ["page"] },
      { type: "file", path: at("source.txt"), tags: ["source"] },
      { type: "file", path: "../facts.md", tags: ["facts"] },
    ] });
  }
} finally {
  await browser.close();
}
writeFileSync(join(here, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`${cases.length} variants written`);
