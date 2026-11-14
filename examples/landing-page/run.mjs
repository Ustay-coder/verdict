#!/usr/bin/env node
// Ask Claude Code for a landing page, score it with the frozen rubric, hand the failures back, repeat.
//
//   node run.mjs [--rounds 5] [--out rounds] [--work <folder Claude works in>]
//
// Needs: the `claude` CLI signed in, `verdict` (or this repository built), Playwright with Chromium,
// and CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for Clef. Each round is kept in <out>/rNN/:
// index.html, desktop.png, mobile.png, full.png, eval.json, claude.json, and the message sent to Claude.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const maxRounds = Number(arg("rounds", "5"));
const out = resolve(here, arg("out", "rounds"));
const repoCli = resolve(here, "../../packages/cli/dist/bin.js");
const verdict = existsSync(repoCli) ? [process.execPath, repoCli] : ["verdict"];

// Claude works in an empty folder outside the repository, with only the README, as someone starting a page would.
// Claude Code keeps a session per folder, so a run picked up again passes the same one with --work.
const work = arg("work") ? resolve(arg("work")) : mkdtempSync(join(tmpdir(), "verdict-landing-"));
mkdirSync(work, { recursive: true });
copyFileSync(resolve(here, "../../README.md"), join(work, "README.md"));

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} exited ${r.status}\n${r.stderr}`);
  return r.stdout;
};

async function screenshots(html, dir) {
  // require, not import: a global Playwright is found through NODE_PATH, which ESM imports ignore.
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  try {
    const shots = [
      ["desktop.png", { width: 1280, height: 800 }, false],
      ["mobile.png", { width: 390, height: 844 }, false],
      ["full.png", { width: 1280, height: 800 }, true],
    ];
    for (const [name, viewport, fullPage] of shots) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
      await page.goto(`file://${html}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(dir, name), fullPage });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

function score(dir) {
  const json = run(verdict[0], [
    ...verdict.slice(1), "eval", "-r", resolve(here, "landing-page.yaml"), "--strict", "--lock", resolve(here, "verdict.lock"),
    "-i", `desktop=${join(dir, "desktop.png")}`, "-i", `mobile=${join(dir, "mobile.png")}`,
    "-i", `page=${join(dir, "index.html")}`, "-i", `source=${join(dir, "source.txt")}`,
    "-i", `facts=${resolve(here, "facts.md")}`, "-n", dir.split("/").pop(), "--json",
  ], { env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" } });
  writeFileSync(join(dir, "eval.json"), json);
  return JSON.parse(json);
}

// What Verdict reported, as the developer would paste it back: each failed gate and each criterion below 2 of 3,
// with the description of the level it was given. The rubric itself is never shown to Claude.
function failures(evaluation) {
  const rubric = evaluation.rubric;
  const lines = [];
  for (const c of evaluation.criteria) {
    const def = rubric.criteria.find((d) => d.id === c.criterionId);
    const r = c.ratings?.[0] ?? {};
    const isGate = def.weight === 0;
    if (isGate ? c.score >= 1 : c.score >= 2) continue;
    let level;
    if (isGate) level = def.anchors?.fail ?? "(rule) failed";
    else level = def.levels?.find((l) => l.value === c.score)?.description ?? `${c.score}/3`;
    const how = r.judgeType === "benchmark" ? "rule" : `${Math.round(Math.max(...Object.values(r.probabilities ?? { x: 0 })) * 100)}%`;
    lines.push(`- ${isGate ? "BLOCKS DEPLOY — " : ""}${def.name} (${isGate ? "fail" : `${c.score}/3`}, ${how}): ${level}`);
  }
  return lines;
}

mkdirSync(out, { recursive: true });
const summary = [];
let session;
let message = readFileSync(resolve(here, "prompt.md"), "utf8");
for (let round = 0; round < maxRounds; round++) {
  const dir = join(out, `r${String(round).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "message.md"), message);

  if (existsSync(join(dir, "claude.json")) && existsSync(join(dir, "index.html"))) {
    // A round Claude already answered is kept, never asked again: a second answer would be a choice between two.
    session = JSON.parse(readFileSync(join(dir, "claude.json"), "utf8")).session_id;
    copyFileSync(join(dir, "index.html"), join(work, "index.html"));
  } else {
    const args = ["-p", message, "--allowedTools", "Read,Write,Edit", "--output-format", "json"];
    if (session) args.push("--resume", session);
    const reply = JSON.parse(run("claude", args, { cwd: work }));
    session = reply.session_id;
    writeFileSync(join(dir, "claude.json"), JSON.stringify({ result: reply.result, session_id: reply.session_id, cost_usd: reply.total_cost_usd, duration_ms: reply.duration_ms, model: Object.keys(reply.modelUsage ?? {}) }, null, 2));
    copyFileSync(join(work, "index.html"), join(dir, "index.html"));
  }
  copyFileSync(join(work, "index.html"), join(dir, "source.txt"));
  await screenshots(join(dir, "index.html"), dir);
  const evaluation = score(dir);

  const row = { round, score: evaluation.aggregate.score, passed: evaluation.aggregate.passed, criteria: {} };
  for (const c of evaluation.criteria) row.criteria[c.criterionId] = c.score;
  summary.push(row);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`round ${round}: ${row.score}/100 ${row.passed ? "PASS" : "fail"}  ${JSON.stringify(row.criteria)}`);
  if (row.passed) break;

  message = readFileSync(resolve(here, "feedback.md"), "utf8")
    .replace("{{score}}", String(row.score))
    .replace("{{failures}}", failures(evaluation).join("\n"));
}
