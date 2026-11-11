// Turns a quality report into a concrete brief for a coding agent. The brief names files, criteria and the exact
// metric findings; it also restates the guard rails the agent must respect.
export function buildBrief({ report, metrics, config, target, round }) {
  const lines = [];
  const weightedMeans = criterionMeans(report.files);
  const focus = report.files
    .filter((f) => f.lines >= config.fileFocus.minLines && f.score < config.fileFocus.below)
    .sort((a, b) => b.lines * (config.fileFocus.below - b.score) - a.lines * (config.fileFocus.below - a.score))
    .slice(0, config.fileFocus.max);
  const findings = Object.entries(metrics.perFile ?? {}).flatMap(([file, v]) => v.messages.map((m) => `${file}:${m.line} ${m.rule} — ${m.message.replace(/\s+/g, " ").slice(0, 100)}`));
  lines.push(`# Code-quality improvement brief (round ${round}, target ${target})`, "",
    "Read AGENTS.md, examples/rubrics/code-quality-repo.yaml and examples/rubrics/code-quality-file.yaml first.",
    `Current score: ${report.overall.toFixed(1)} / 100 (repository ${report.repo.score.toFixed(1)}, files ${report.fileMean.toFixed(1)}, line-weighted).`, "",
    "## Rules",
    "- Keep every test passing and public behaviour unchanged. `node scripts/harness/smoke.mjs` must keep printing \"behaviour unchanged\".",
    `- Do not edit: ${config.protectedPaths.join(", ")}.`,
    "- Do not run package installs or commit. Do not split modules merely to shrink files; fix what the criteria name.",
    "- `NODE_USE_ENV_PROXY=1 node scripts/code-metrics.mjs --no-coverage` is fast and offline: run it to check the measured half. The model review cannot run in your sandbox; the harness runs it afterwards.", "");
  if (findings.length) lines.push("## Measured findings to eliminate", ...findings.map((f) => `- ${f}`), "");
  const dup = metrics.duplication;
  if (dup?.percentage > config.metricsFloor.duplicationMaxPct) lines.push(`## Duplication ${dup.percentage.toFixed(2)} % (max ${config.metricsFloor.duplicationMaxPct})`, ...(dup.examples ?? []).map((e) => `- ${e}`), "");
  lines.push("## File-review criteria (line-weighted means, 1–5)", Object.entries(weightedMeans).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" · "), "");
  lines.push(`## Files to improve (lines × gap order; weakest three criteria each)`);
  for (const f of focus) {
    const weak = Object.entries(f.criteria).filter(([k]) => !["file_length", "unchecked_casts"].includes(k)).sort((a, b) => a[1].score - b[1].score).slice(0, 3).map(([k, v]) => `${k} ${v.score.toFixed(1)}`).join(", ");
    lines.push(`- ${f.file} (${f.lines} lines, ${f.score.toFixed(1)}): ${weak}`);
  }
  lines.push("", "## What each criterion means at 5 (apply only where the file's weak criteria say so)",
    "- error_handling: every failure the file can produce is explicit, typed (ValidationError / NotFoundError / ConflictError / ProviderError / FileAccessError / StoreError) and recoverable; edge cases visible. Files with no failure modes already score 5 — do not add defensive noise.",
    "- comments: each non-obvious threshold, fallback, ordering or invariant has a one-line reason; no comment restates code; nothing stale.",
    "- testability: dependencies (fetch, env, clock, ids, fs, drivers) come in as parameters with defaults; no module-level globals outside composition roots.",
    "- types: no `as unknown as` / `as never` / `Record<string, unknown>` where a precise type exists; provider payloads validated with zod.",
    "- analysability: named steps, early returns, no nested ternaries; functions ≤ 60 lines, cognitive complexity ≤ 15.",
    "- dead_code: delete unreferenced exports (grep across packages and tests first) and duplicated branches.",
    "", "## Done means",
    "`NODE_USE_ENV_PROXY=1 pnpm build && pnpm test && pnpm lint --max-warnings 0` pass and the smoke goldens are unchanged. Finish with a per-file summary of what changed and anything deliberately left, with the reason.");
  return lines.join("\n");
}

function criterionMeans(files) {
  const tot = files.reduce((s, f) => s + f.lines, 0) || 1;
  const ids = Object.keys(files[0]?.criteria ?? {}).filter((k) => !["file_length", "unchecked_casts"].includes(k));
  return Object.fromEntries(ids.map((id) => [id, files.reduce((s, f) => s + (f.criteria[id]?.score ?? 0) * f.lines, 0) / tot]));
}
