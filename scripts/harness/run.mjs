#!/usr/bin/env node
/**
 * Evaluation-driven improvement harness: measure code quality with Verdict, hand the weakest findings to a coding
 * agent, verify the result (build, tests, lint, metric floors, behaviour goldens), re-score, and keep or revert.
 *
 * Usage: node scripts/harness/run.mjs [--rounds N] [--target 90] [--plan-only] [--agent "cmd"] [--no-commit] [--judge jev|clef]
 *   --plan-only   measure and write the agent brief, run nothing
 *   --rounds 0    measure only
 *   --agent       override the agent command (e.g. "claude -p" or "sh -c true" for a loop dry run)
 *
 * Invariants learned the hard way (see docs/HARNESS.md):
 *  - the model review runs HERE, never inside the agent's sandbox (no network there → benchmark-only "scores");
 *  - stdin to the agent is closed, or Codex waits for input forever;
 *  - behaviour goldens gate every round: green tests are not proof that behaviour survived;
 *  - protected paths (rubrics, scorer, harness, lint config, workflows) must not be touched by the agent.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBrief } from "./plan.mjs";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const flag = (n) => args.includes(n);
const config = JSON.parse(readFileSync(join(root, "scripts/harness/config.json"), "utf8"));
const target = Number(opt("--target", config.target));
const rounds = Number(opt("--rounds", config.maxRounds));
const judge = opt("--judge", config.judge);
const commitEnabled = config.commit.enabled && !flag("--no-commit");
const agentCmd = opt("--agent");
const outDir = join(root, ".verdict-quality");
mkdirSync(outDir, { recursive: true });
const env = { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" };
const sh = (cmd, opts = {}) => execFileSync("bash", ["-lc", cmd], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
const log = (m) => console.log(`[harness ${new Date().toISOString().slice(11, 19)}] ${m}`);

function measure(label) {
  const metricsPath = join(outDir, `${label}-metrics.json`), scorePath = join(outDir, `${label}-score.json`);
  sh(`node scripts/code-metrics.mjs --out ${metricsPath}`);
  const out = sh(`node scripts/score-code.mjs --metrics ${metricsPath} --judge ${judge} --out ${scorePath}`);
  const report = JSON.parse(readFileSync(scorePath, "utf8"));
  if (report.files.some((f) => f.error)) throw new Error("model review had provider errors; refusing to score on benchmarks alone");
  log(`${label}: overall ${report.overall.toFixed(1)} (repo ${report.repo.score.toFixed(1)}, files ${report.fileMean.toFixed(1)})`);
  return { report, metrics: JSON.parse(readFileSync(metricsPath, "utf8")), stdout: out };
}

function metricsOk(m) {
  const f = config.metricsFloor, c = m.complexity, problems = [];
  if (c.cognitiveViolations > f.cognitiveViolations) problems.push(`cognitive complexity violations ${c.cognitiveViolations}`);
  if (c.longFunctions > f.longFunctions) problems.push(`long functions ${c.longFunctions}`);
  if (c.longFiles > f.longFiles) problems.push(`long files ${c.longFiles}`);
  if (m.types.unusedVars > f.unusedVars) problems.push(`unused vars ${m.types.unusedVars}`);
  if (m.lint.errors > f.lintErrors) problems.push(`lint errors ${m.lint.errors}`);
  if ((m.duplication.percentage ?? 0) > f.duplicationMaxPct) problems.push(`duplication ${m.duplication.percentage.toFixed(2)} %`);
  return problems;
}

function verify() {
  for (const [name, cmd] of Object.entries(config.verify)) {
    try { sh(cmd); log(`verify ${name}: ok`); }
    catch (e) { return `${name} failed:\n${String(e.stdout ?? "").slice(-1200)}\n${String(e.stderr ?? "").slice(-800)}`; }
  }
  try { sh("node scripts/harness/smoke.mjs"); log("verify smoke: behaviour unchanged"); }
  catch (e) { return `behaviour goldens differ:\n${String(e.stdout ?? "").slice(-1500)}`; }
  const touched = sh("git status --porcelain").split("\n").filter(Boolean).map((l) => l.slice(3));
  const violated = touched.filter((p) => config.protectedPaths.some((pp) => p.startsWith(pp)));
  if (violated.length) return `protected paths modified: ${violated.join(", ")}`;
  return null;
}

async function runAgent(briefPath, round) {
  const brief = readFileSync(briefPath, "utf8");
  const [cmd, ...cmdArgs] = agentCmd ? ["bash", "-lc", `${agentCmd} "$(cat ${briefPath})"`] : [config.agent.command, ...config.agent.args.map((a) => (a === "." ? root : a)), brief];
  const logPath = join(outDir, `round${round}-agent.log`);
  log(`agent: ${agentCmd ?? config.agent.command} (log ${logPath})`);
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); // stdin closed on purpose
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill("SIGTERM"); out += "\n[harness] agent timed out"; }, config.agent.timeoutMinutes * 60_000);
    child.on("close", (code) => { clearTimeout(timer); writeFileSync(logPath, out); resolve(code); });
  });
}

function commit(round, before, after) {
  if (!commitEnabled) return log("commit disabled; changes left in the working tree");
  const [name, email] = /^(.*) <(.*)>$/.exec(config.commit.author).slice(1);
  const msg = `Quality harness round ${round}: ${before.toFixed(1)} -> ${after.toFixed(1)}\n\nAutomated improvement round driven by the code-quality rubric. Build, tests,\nlint, metric floors and behaviour goldens passed before this commit.`;
  sh(`git add -A && git -c user.name="${name}" -c user.email="${email}" commit -q -F -`, { input: msg, stdio: ["pipe", "pipe", "pipe"] });
  log(`committed round ${round}`);
}

async function main() {
  if (sh("git status --porcelain").trim()) throw new Error("working tree must be clean before the harness runs");
  let current = measure("baseline");
  const history = [{ round: 0, overall: current.report.overall }];
  const floor = metricsOk(current.metrics);
  if (floor.length) log(`metric floors not met at baseline: ${floor.join("; ")} — the first brief targets them`);
  for (let round = 1; round <= rounds; round++) {
    if (current.report.overall >= target && !floor.length) { log(`target ${target} reached`); break; }
    const briefPath = join(outDir, `round${round}-brief.md`);
    writeFileSync(briefPath, buildBrief({ report: current.report, metrics: current.metrics, config, target, round }));
    log(`brief written: ${briefPath}`);
    if (flag("--plan-only")) break;
    const code = await runAgent(briefPath, round);
    log(`agent exited ${code}`);
    if (!sh("git status --porcelain").trim()) { log("agent changed nothing; stopping"); break; }
    const failure = verify();
    if (failure) { log(`round ${round} rejected: ${failure.split("\n")[0]}`); writeFileSync(join(outDir, `round${round}-rejected.txt`), failure); sh("git checkout -- . && git clean -fd -e .verdict-quality"); continue; }
    const next = measure(`round${round}`);
    const floorNow = metricsOk(next.metrics);
    if (floorNow.length || next.report.overall < current.report.overall - 0.05) {
      log(`round ${round} rejected: ${floorNow.length ? floorNow.join("; ") : `score fell ${current.report.overall.toFixed(1)} -> ${next.report.overall.toFixed(1)}`}`);
      sh("git checkout -- . && git clean -fd -e .verdict-quality"); continue;
    }
    commit(round, current.report.overall, next.report.overall);
    history.push({ round, overall: next.report.overall });
    current = next;
  }
  writeFileSync(join(outDir, "history.json"), JSON.stringify({ target, judge, history, finishedAt: new Date().toISOString() }, null, 2));
  log(`done: ${history.map((h) => `${h.round}:${h.overall.toFixed(1)}`).join(" → ")}${current.report.overall >= target ? " ✓" : ` (target ${target} not reached)`}`);
  process.exit(current.report.overall >= target ? 0 : 2);
}
main().catch((e) => { console.error(`[harness] ${e.message}`); process.exit(1); });
