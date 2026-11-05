#!/usr/bin/env node
// Scores landing-page drafts against examples/rubrics/landing-page.yaml and prints one bar per draft,
// plus the weakest criterion: the thing the next rewrite should fix. This is the "score climbs" shot of the video.
//
//   node examples/demo/landing-loop/scoreboard.mjs                 # v1.md … v4.md in this folder
//   node examples/demo/landing-loop/scoreboard.mjs path/to/page.md # any drafts, in order
//   node examples/demo/landing-loop/scoreboard.mjs --mock          # rehearsal, no API calls (scores are meaningless)
//
// Live runs need TYPESAFE_API_KEY (Jev) and CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Clef-flash);
// in Claude Code cloud sessions prefix with NODE_USE_ENV_PROXY=1.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const cli = join(repo, "packages/cli/dist/bin.js");
const rubric = join(repo, "examples/rubrics/landing-page.yaml");

const args = process.argv.slice(2);
const mock = args.includes("--mock");
const files = args.filter((a) => a !== "--mock");
const drafts = files.length ? files.map((f) => resolve(f)) : readdirSync(here).filter((f) => /^v\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).map((f) => join(here, f));

const run = promisify(execFile);
async function score(file) {
  const started = Date.now();
  const { stdout } = await run(process.execPath, [cli, "eval", "-r", rubric, "-i", file, "--json", ...(mock ? ["--mock"] : [])], { maxBuffer: 16 << 20 });
  const ev = JSON.parse(stdout);
  const scored = ev.criteria.filter((c) => c.weight > 0 && typeof c.normalized === "number");
  const weakest = scored.sort((a, b) => a.normalized - b.normalized || b.weight - a.weight)[0];
  return { file, ev, weakest, ms: Date.now() - started };
}

const results = await Promise.all(drafts.map(score));
const bar = (n) => "█".repeat(Math.round(n / 5)) + "░".repeat(20 - Math.round(n / 5));
for (const { file, ev, weakest, ms } of results) {
  const s = ev.aggregate.score;
  const line = s == null
    ? `${basename(file).padEnd(8)} ${"·".repeat(20)}    —  aborted: ${(ev.checks ?? []).find((c) => !c.passed)?.message ?? "pre-screen failed"}`
    : `${basename(file).padEnd(8)} ${bar(s)}  ${String(Math.round(s)).padStart(3)}  ${(ev.aggregate.grade ?? "").padEnd(8)} weakest: ${weakest ? `${weakest.name} (${Math.round(weakest.normalized * 100)}%)` : "—"}`;
  console.log(`${line}  ${(ms / 1000).toFixed(1)}s`);
}
if (mock) console.log("\n(--mock: decision judges are faked; only the benchmark criteria are real)");
