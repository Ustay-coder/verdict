#!/usr/bin/env node
// Score the codebase with Verdict: measured repository metrics (code-quality-repo.yaml) + a decision-model review of every
// source file (code-quality-file.yaml). Overall = 50 % repository score + 50 % line-weighted mean file score (SIG-style
// volume weighting, so a 500-line module counts more than a 5-line barrel).
// Usage: NODE_USE_ENV_PROXY=1 node scripts/score-code.mjs [--metrics metrics.json] [--out report.json] [--no-coverage]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Engine, MemoryStore, loadRubricText } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const repoRubric = loadRubricText(readFileSync(join(root, "examples/rubrics/code-quality-repo.yaml"), "utf8"));
const fileRubric = loadRubricText(readFileSync(join(root, "examples/rubrics/code-quality-file.yaml"), "utf8"));

let metrics;
if (opt("--metrics")) metrics = JSON.parse(readFileSync(opt("--metrics"), "utf8"));
else {
  const tmp = join(root, ".verdict-metrics.json");
  execFileSync("node", [join(root, "scripts/code-metrics.mjs"), "--out", tmp, ...(args.includes("--no-coverage") ? ["--no-coverage"] : [])], { stdio: ["ignore", "ignore", "inherit"] });
  metrics = JSON.parse(readFileSync(tmp, "utf8"));
}
const { perFile, ...repoMetrics } = metrics;

const engine = new Engine({ store: new MemoryStore(), concurrency: 6 });
const started = Date.now();
const repo = await engine.evaluate({ rubric: repoRubric, subject: { name: "repository", inputs: [{ type: "json", data: repoMetrics, label: "metrics", tags: ["metrics"] }] } });

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return ["node_modules", "dist", "test"].includes(n) ? [] : sourceFiles(p);
    return n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts") ? [p] : [];
  });
}
const files = metrics.packages.flatMap((p) => sourceFiles(join(root, "packages", p, "src"))).sort();
const fileResults = [];
const jobs = files.map((f) => async () => {
  const rel = relative(root, f);
  const text = readFileSync(f, "utf8");
  const ev = await engine.evaluate({ rubric: fileRubric, subject: { name: rel, inputs: [{ type: "text", text, label: rel, tags: ["file"] }] } });
  const errors = ev.criteria.filter((c) => c.ratings.some((r) => r.status === "error")).map((c) => `${c.criterionId}: ${c.ratings.find((r) => r.error)?.error}`);
  fileResults.push({ file: rel, lines: text.split("\n").length, score: errors.length ? NaN : ev.aggregate.score, grade: errors.length ? "ERR" : ev.aggregate.grade, error: errors.join("; ") || undefined,
    criteria: Object.fromEntries(ev.criteria.map((c) => [c.criterionId, { score: c.score, confidence: c.ratings[0]?.confidence }])), lint: perFile?.[rel] });
});
let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < jobs.length) await jobs[i++](); }));
fileResults.sort((a, b) => (isNaN(a.score) ? 1e9 : a.score) - (isNaN(b.score) ? 1e9 : b.score));

const scored = fileResults.filter((r) => !isNaN(r.score));
const weight = (r) => Math.max(1, r.lines);
const fileMean = scored.reduce((s, r) => s + r.score * weight(r), 0) / Math.max(1, scored.reduce((s, r) => s + weight(r), 0));
const overall = repo.aggregate.score === undefined ? NaN : 0.5 * repo.aggregate.score + 0.5 * fileMean;

console.log(`=== Repository metrics  score ${repo.aggregate.score?.toFixed(1)} (${repo.aggregate.grade})`);
for (const c of repo.criteria) console.log(`  ${c.name.padEnd(76)} ${String(c.score?.toFixed(1) ?? c.status).padStart(6)}`);
const ids = Object.keys(fileResults[0]?.criteria ?? {});
const short = { cohesion: "cohes", analysability: "analy", naming: "name", error_handling: "errs", types: "types", comments: "cmnts", testability: "test", dead_code: "dead", file_length: "len", unchecked_casts: "casts" };
console.log(`\n=== Source files (${files.length}, Jev)  line-weighted mean ${fileMean.toFixed(1)}`);
console.log(["file".padEnd(44), "lines", "score", ...ids.map((i) => (short[i] ?? i).padStart(5))].join(" "));
for (const r of fileResults) console.log([r.file.padEnd(44), String(r.lines).padStart(5), (isNaN(r.score) ? "ERR" : r.score.toFixed(1)).padStart(5), ...ids.map((i) => String(r.criteria[i].score?.toFixed(1) ?? "-").padStart(5))].join(" "));
console.log(`\nper-criterion mean: ${ids.map((i) => `${short[i] ?? i}=${(scored.reduce((s, r) => s + (r.criteria[i].score ?? 0), 0) / Math.max(1, scored.length)).toFixed(2)}`).join(" ")}`);
console.log(`\n=== OVERALL ${overall.toFixed(1)} / 100   (repo ${repo.aggregate.score?.toFixed(1)} × 0.5 + files ${fileMean.toFixed(1)} × 0.5)   ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (fileResults.some((r) => r.error)) { console.error(`\n${fileResults.filter((r) => r.error).length} file(s) could not be judged:`); for (const r of fileResults.filter((r) => r.error)) console.error(`  ${r.file}: ${r.error.slice(0, 160)}`); }
if (opt("--out")) writeFileSync(opt("--out"), JSON.stringify({ generatedAt: new Date().toISOString(), overall, repo: { score: repo.aggregate.score, criteria: repo.criteria.map((c) => ({ id: c.criterionId, score: c.score })) }, fileMean, files: fileResults, metrics: repoMetrics }, null, 2));
if (fileResults.some((r) => r.error) || repo.status !== "completed") process.exit(1);
