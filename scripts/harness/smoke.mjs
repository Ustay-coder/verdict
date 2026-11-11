#!/usr/bin/env node
// Behaviour golden tests: run deterministic evaluations (mock / benchmark judges) and compare to scripts/harness/golden.json.
// Tests can pass while behaviour changes (round two broke PDF ingestion with 149 green tests); this catches that.
// Usage: node scripts/harness/smoke.mjs [--update]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const cli = `${root}/packages/cli/dist/bin.js`;
const cases = [
  { name: "pitch-mock-panel-human", args: ["eval", "-r", "examples/rubrics/startup-pitch.yaml", "-i", "examples/inputs/pitch.md", "-i", "deck=examples/inputs/pitch.pdf", "-n", "Acme", "--mock", "--json"] },
  { name: "triage-mock-checks-choice", args: ["eval", "-r", "examples/rubrics/decision-triage.yaml", "-i", "text:Our dashboard is down and we will cancel", "--mock", "--json"] },
  { name: "offline-benchmark", args: ["eval", "-r", "examples/rubrics/offline-benchmark.yaml", "-i", "ci=examples/inputs/ci.json", "-i", "examples/inputs/CHANGELOG.md", "--json"] },
  { name: "compare-ranking", args: ["compare", "-r", "examples/rubrics/offline-benchmark.yaml", "-s", "v2=examples/inputs/ci.json,examples/inputs/CHANGELOG.md", "-s", "v1=text:no changelog", "--json"] },
];

/** Keep only the behaviour-bearing fields so ids and timestamps do not churn the golden file. */
function project(name, json) {
  if (Array.isArray(json)) return json.map((r) => ({ rank: r.rank, subject: r.subject, score: r.score, grade: r.grade, passed: r.passed, status: r.status }));
  return {
    status: json.status, score: json.aggregate?.score, grade: json.aggregate?.grade, passed: json.aggregate?.passed,
    checks: json.checks?.map((c) => ({ id: c.id, passed: c.passed, action: c.action })),
    criteria: json.criteria?.map((c) => ({ id: c.criterionId, status: c.status, score: c.score, choice: c.choice, pending: c.pending, errors: c.ratings?.filter((r) => r.status === "error").map((r) => r.error?.slice(0, 80)) })),
    evidence: json.evidence?.map((e) => ({ label: e.label, chars: e.chars ?? e.text?.length, truncated: !!e.truncated })),
    decisionCalls: json.usage?.decisionCalls, llmCalls: json.usage?.llmCalls,
  };
}

const results = {};
for (const c of cases) {
  const out = execFileSync("node", [cli, ...c.args], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1", VERDICT_DATA_DIR: `${root}/.verdict-quality/smoke-store` }, maxBuffer: 32 * 1024 * 1024 });
  results[c.name] = project(c.name, JSON.parse(out));
}
const goldenPath = `${root}/scripts/harness/golden.json`;
if (process.argv.includes("--update")) { writeFileSync(goldenPath, JSON.stringify(results, null, 2) + "\n"); console.log(`golden updated: ${Object.keys(results).length} cases`); process.exit(0); }
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
let failed = 0;
for (const name of Object.keys(golden)) {
  const a = JSON.stringify(golden[name]), b = JSON.stringify(results[name]);
  if (a === b) console.log(`✓ ${name}`);
  else { failed++; console.log(`✗ ${name}\n   expected ${a.slice(0, 400)}\n   actual   ${b.slice(0, 400)}`); }
}
console.log(failed ? `${failed} smoke case(s) differ from golden` : "smoke: behaviour unchanged");
process.exit(failed ? 1 : 0);
