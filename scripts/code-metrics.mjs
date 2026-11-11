#!/usr/bin/env node
// Collect repository-level code-quality metrics as JSON (input for examples/rubrics/code-quality-repo.yaml).
// Sources: vitest v8 coverage, ESLint (typescript-eslint + sonarjs cognitive complexity + unit-size rules), jscpd, pnpm audit, grep.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const quick = process.argv.includes("--no-coverage");
const run = (cmd, opts = {}) => spawnSync("bash", ["-lc", cmd], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" }, ...opts });

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return ["node_modules", "dist", "test"].includes(n) ? [] : sourceFiles(p);
    return n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts") ? [p] : [];
  });
}
const packages = readdirSync(join(root, "packages")).filter((p) => existsSync(join(root, "packages", p, "src")));
const files = packages.flatMap((p) => sourceFiles(join(root, "packages", p, "src")));
const loc = files.reduce((s, f) => s + readFileSync(f, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, 0);
const kloc = loc / 1000;

/* ---- coverage: run each package's vitest with v8 coverage, sum line totals ---- */
let coverage = { lines: null, branches: null, functions: null, perPackage: {} };
if (!quick) {
  let covered = 0, total = 0, bcov = 0, btot = 0, fcov = 0, ftot = 0;
  for (const p of packages) {
    const dir = join(root, "packages", p);
    if (!existsSync(join(dir, "test"))) continue;
    const r = run(`cd packages/${p} && npx vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json-summary --coverage.reportsDirectory=coverage --coverage.include='src/**/*.ts' --coverage.exclude='src/**/*.d.ts' --passWithNoTests`);
    const summaryPath = join(dir, "coverage", "coverage-summary.json");
    if (!existsSync(summaryPath)) { coverage.perPackage[p] = { error: (r.stderr || r.stdout).slice(-300) }; continue; }
    const s = JSON.parse(readFileSync(summaryPath, "utf8")).total;
    coverage.perPackage[p] = { lines: s.lines.pct, branches: s.branches.pct, functions: s.functions.pct };
    covered += s.lines.covered; total += s.lines.total; bcov += s.branches.covered; btot += s.branches.total; fcov += s.functions.covered; ftot += s.functions.total;
    rmSync(join(dir, "coverage"), { recursive: true, force: true });
  }
  coverage.lines = total ? +(100 * covered / total).toFixed(2) : null;
  coverage.branches = btot ? +(100 * bcov / btot).toFixed(2) : null;
  coverage.functions = ftot ? +(100 * fcov / ftot).toFixed(2) : null;
}

/* ---- lint + complexity + unit size (ESLint JSON) ---- */
const lintRun = run(`npx eslint packages/*/src --ext .ts --format json`);
let lintJson = [];
try { lintJson = JSON.parse(lintRun.stdout.slice(lintRun.stdout.indexOf("["))); } catch { lintJson = []; }
const byRule = {};
const perFile = {};
for (const f of lintJson) {
  const rel = relative(root, f.filePath);
  perFile[rel] = { errors: f.errorCount, warnings: f.warningCount, messages: f.messages.map((m) => ({ rule: m.ruleId, line: m.line, message: m.message })) };
  for (const m of f.messages) byRule[m.ruleId ?? "parse"] = (byRule[m.ruleId ?? "parse"] ?? 0) + 1;
}
const count = (rule) => byRule[rule] ?? 0;
// Function count (rough): declarations, methods, arrows assigned to const/let, class methods.
const functionCount = files.reduce((s, f) => s + (readFileSync(f, "utf8").match(/\bfunction\b\s*\w*\s*\(|=>\s*[{(]|^\s+(?:async\s+)?\w+\s*\([^)]*\)\s*(?::[^{]+)?\{/gm)?.length ?? 0), 0);
const lint = {
  errors: lintJson.reduce((s, f) => s + f.errorCount, 0),
  warnings: lintJson.reduce((s, f) => s + f.warningCount, 0),
  errorsPerKloc: +(lintJson.reduce((s, f) => s + f.errorCount, 0) / kloc).toFixed(2),
  byRule,
};
const complexity = {
  functions: functionCount,
  cognitiveViolations: count("sonarjs/cognitive-complexity"),
  cognitiveViolationsPer100Functions: +(100 * count("sonarjs/cognitive-complexity") / Math.max(1, functionCount)).toFixed(2),
  longFunctions: count("max-lines-per-function"),
  longFiles: count("max-lines"),
  deepNesting: count("max-depth"),
  manyParams: count("max-params"),
};
const types = {
  explicitAny: count("@typescript-eslint/no-explicit-any"),
  anyPerKloc: +(count("@typescript-eslint/no-explicit-any") / kloc).toFixed(2),
  unusedVars: count("@typescript-eslint/no-unused-vars"),
  strict: /"strict":\s*true/.test(readFileSync(join(root, "tsconfig.base.json"), "utf8")),
};

/* ---- duplication (jscpd) ---- */
const dupDir = mkdtempSync(join(tmpdir(), "jscpd-"));
run(`npx jscpd packages/*/src --format typescript --min-lines 8 --min-tokens 60 --reporters json --output ${dupDir} --silent --ignore "**/*.test.ts,**/dist/**"`);
let duplication = { percentage: null, clones: null };
try { const j = JSON.parse(readFileSync(join(dupDir, "jscpd-report.json"), "utf8")); duplication = { percentage: j.statistics.total.percentage, clones: j.statistics.total.clones, duplicatedLines: j.statistics.total.duplicatedLines, examples: j.duplicates.slice(0, 8).map((d) => `${relative(root, d.firstFile.name)}:${d.firstFile.start}-${d.firstFile.end} ~ ${relative(root, d.secondFile.name)}:${d.secondFile.start}-${d.secondFile.end}`) }; } catch {}
rmSync(dupDir, { recursive: true, force: true });

/* ---- security (pnpm audit) ---- */
const auditRun = run(`pnpm audit --json --prod 2>/dev/null || true`);
let security = { high: 0, critical: 0, moderate: 0, low: 0 };
try { const a = JSON.parse(auditRun.stdout.slice(auditRun.stdout.indexOf("{"))); security = { ...security, ...a.metadata.vulnerabilities }; } catch {}

/* ---- tests ---- */
const testFiles = packages.flatMap((p) => existsSync(join(root, "packages", p, "test")) ? readdirSync(join(root, "packages", p, "test")).filter((f) => f.endsWith(".test.ts")).length : 0).reduce((a, b) => a + b, 0);
const typecheck = run(`pnpm typecheck`).status === 0;

const metrics = { generatedAt: new Date().toISOString(), packages, files: files.length, loc, kloc: +kloc.toFixed(2), testFiles, typecheck, coverage, lint, complexity, types, duplication, security, perFile };
if (out) writeFileSync(out, JSON.stringify(metrics, null, 2));
const { perFile: _pf, ...summary } = metrics;
console.log(JSON.stringify({ ...summary, lint: { ...summary.lint, byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 8)) } }, null, 2));
