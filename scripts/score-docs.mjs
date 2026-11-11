#!/usr/bin/env node
// Score every documentation page with Verdict itself (examples/rubrics/docs-quality.yaml).
// Usage: NODE_USE_ENV_PROXY=1 node scripts/score-docs.mjs [--out report.json] [--judge jev|clef]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Engine, MemoryStore, loadRubricText } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const judge = args.includes("--judge") ? args[args.indexOf("--judge") + 1] : "jev";
const root = new URL("../website/", import.meta.url).pathname;
const rubric = loadRubricText(readFileSync(new URL("../examples/rubrics/docs-quality.yaml", import.meta.url), "utf8"));
if (judge === "clef") rubric.defaultJudge = { type: "decision", provider: "cloudflare", model: "@cf/cloudflare/clef-flash", onLowConfidence: "accept", escalateTo: [] };

function pages(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n.startsWith(".") || n === "node_modules" ? [] : pages(p);
    return n.endsWith(".md") ? [p] : [];
  });
}
const files = pages(root).sort();
const docs = files.map((f) => {
  const raw = readFileSync(f, "utf8").replace(/^---[\s\S]*?---\n/, "");
  const title = /^#\s+(.+)$/m.exec(raw)?.[1] ?? relative(root, f);
  const headings = [...raw.matchAll(/^##+\s+(.+)$/gm)].map((m) => m[1]);
  const first = raw.replace(/^#.*$/m, "").trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").slice(0, 240) ?? "";
  return { path: relative(root, f), text: raw, title, headings, first };
});

const engine = new Engine({ store: new MemoryStore(), concurrency: 4 });
const started = Date.now();
const results = [];
for (const d of docs) {
  const outline = docs.filter((o) => o !== d).map((o) => `- ${o.path}: "${o.title}" — sections: ${o.headings.join(" | ") || "(none)"}\n  starts: ${o.first}`).join("\n");
  const ev = await engine.evaluate({
    rubric,
    subject: { name: d.path, inputs: [{ type: "text", text: d.text, label: d.path, tags: ["page"] }, { type: "text", text: `Other pages on this site:\n${outline}`, label: "outline", tags: ["outline"] }] },
  });
  results.push({ page: d.path, words: d.text.split(/\s+/).filter(Boolean).length, score: ev.aggregate.score, grade: ev.aggregate.grade, ms: ev.usage.durationMs, calls: ev.usage.decisionCalls, tokens: ev.usage.inputTokens,
    criteria: Object.fromEntries(ev.criteria.map((c) => [c.criterionId, { score: c.score, confidence: c.ratings[0]?.confidence, probabilities: c.ratings[0]?.probabilities, error: c.ratings.find((r) => r.error)?.error }])) });
}
// A page whose judge calls failed has no meaningful score: show ERR, exclude it from the mean, and exit non-zero.
let failures = 0;
for (const r of results) {
  const errs = Object.entries(r.criteria).filter(([, c]) => c.error);
  if (errs.length) { failures++; r.score = NaN; r.grade = "ERR"; r.error = errs.map(([id, c]) => `${id}: ${c.error}`).join("; "); }
}
const ids = Object.keys(results[0].criteria);
const short = { slop: "slop", redundancy: "dup", concreteness: "concr", structure: "struct", audience: "audnc", next_step: "next", marketing_phrases: "mktg", length: "len" };
console.log(`judge=${judge}  pages=${results.length}  total ${(Date.now() - started) / 1000}s  tokens ${results.reduce((s, r) => s + r.tokens, 0)}`);
console.log(["page".padEnd(34), "score", "grade", ...ids.map((i) => (short[i] ?? i).padStart(6))].join(" "));
for (const r of [...results].sort((a, b) => (isNaN(a.score) ? 1e9 : a.score) - (isNaN(b.score) ? 1e9 : b.score))) console.log([r.page.padEnd(34), (isNaN(r.score) ? "ERR" : r.score.toFixed(1)).padStart(5), (r.grade ?? "").padEnd(5), ...ids.map((i) => String(r.criteria[i].score?.toFixed(2) ?? "err").padStart(6))].join(" "));
const scored = results.filter((r) => !isNaN(r.score));
const mean = scored.reduce((s, r) => s + r.score, 0) / Math.max(1, scored.length);
if (failures) { console.error(`\n${failures} page(s) could not be judged (provider errors) — scores above exclude them:`); for (const r of results.filter((r) => r.error)) console.error(`  ${r.page}: ${r.error.slice(0, 160)}`); }
console.log(`mean ${mean.toFixed(2)}  |  per-criterion mean: ${ids.map((i) => `${short[i] ?? i}=${(results.reduce((s, r) => s + (r.criteria[i].score ?? 0), 0) / results.length).toFixed(2)}`).join(" ")}`);
if (out) writeFileSync(out, JSON.stringify({ judge, generatedAt: new Date().toISOString(), mean, failures, results }, null, 2));
if (failures) process.exit(1);
