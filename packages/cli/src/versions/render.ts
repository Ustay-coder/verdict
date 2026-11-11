/**
 * Plain-text views of versions, runs and comparisons. Every rate is printed with its denominator; a comparison under
 * different conditions says so on its first line, before any number.
 */
import type { CaseComparison, Comparison, CriterionComparison, Run, RubricVersion } from "@verdict-ai/core";

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : "—");
const rate = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function renderVersion(v: RubricVersion): string[] {
  const lines = [`${v.id}  ${v.rubricKey}  (${v.rubric.criteria.length} criteria, frozen ${v.createdAt})`];
  lines.push(`  judgment ${short(v.judgmentHash)}  policy ${short(v.policyHash)}  binding ${short(v.bindingHash)}  meta ${short(v.metaHash)}`);
  if (v.parentVersionId) lines.push(`  forked from ${v.parentVersionId}: ${v.fork?.changeKinds.join(", ") || "no changes"}${v.fork?.note ? ` — ${v.fork.note}` : ""}`);
  return lines;
}

export function renderRun(run: Run): string[] {
  const c = run.counts;
  const models = run.fingerprint.models.map((m) => `${m.provider}/${m.resolved ?? m.requested ?? "default"}${m.verified ? "" : " (unverified)"}`).join(", ") || "none";
  return [
    `${run.id}  ${run.status}  ${run.rubricVersionId} × ${run.datasetVersionId}`,
    `  cases ${c.cases}: completed ${c.completed}, asked a human ${c.pendingHuman}, failed ${c.failed}${c.invalidInput ? ` (invalid input ${c.invalidInput})` : ""}; labelled ${c.labelled}`,
    `  models ${models}; questions ${short(run.fingerprint.questionsHash)}; ${run.usage.decisionCalls} decision call(s)`,
    ...(run.rescoredFrom ? [`  re-scored from ${run.rescoredFrom}'s recorded answers (no judge calls)`] : []),
  ];
}

const KIND_TEXT: Record<Comparison["kind"], string> = {
  rubric_change: "rubric change — only the rubric's judgment differs",
  policy_change: "policy change — the same answers read another way (threshold, values, weights or aggregation)",
  same_conditions: "same conditions — a repeat of the same version",
  different_conditions: "different conditions — results are not attributable to the rubric alone",
};

// What the kind already says changed; anything else is listed as a difference.
const EXPLAINED: Partial<Record<Comparison["kind"], string[]>> = { rubric_change: ["judgmentHash", "questionsHash"], policy_change: ["policyHash"] };
const unexplainedDiffs = (cmp: Comparison) => cmp.conditions.diffs.filter((d) => !EXPLAINED[cmp.kind]?.includes(d.field));

export function renderComparison(cmp: Comparison): string[] {
  const lines = [`${cmp.base.rubricVersionId} (${cmp.base.runId}) → ${cmp.head.rubricVersionId} (${cmp.head.runId}): ${KIND_TEXT[cmp.kind]}`];
  const other = unexplainedDiffs(cmp);
  if (other.length) lines.push(`  differs: ${other.map((d) => d.field).join(", ")}`);
  const rescored = [cmp.labels.rescored.base && "base", cmp.labels.rescored.head && "head"].filter(Boolean);
  lines.push(`  labels ${cmp.labels.datasetVersionId}${rescored.length ? ` (re-scored: ${rescored.join(", ")})` : ""}`);
  for (const c of cmp.criteria) lines.push(...renderCriterion(c));
  return lines;
}

function renderCriterion(c: CriterionComparison): string[] {
  const n = c.counts;
  const lines = [`${c.criterionId}  ${n.cases} cases · both scored ${n.commonSucceeded} · labelled ${n.labelled}`];
  if (!c.contract.same) {
    lines.push("  answer contract changed (levels or options): no rates; cases side by side");
    for (const row of c.cases) lines.push(`  · ${caseLine(row)}`);
    return lines;
  }
  lines.push(`  agreement ${rate(c.agreement.base)} → ${rate(c.agreement.head)} (n=${c.agreement.n})`);
  lines.push(`  fixed ${n.fixed} · regressed ${n.regressed} · kept ${n.kept_match + n.kept_miss} (match ${n.kept_match}, miss ${n.kept_miss}) · changed unlabelled ${n.changed_unlabelled} · asked a human ${n.escalated} · error ${n.error} · missing ${n.missing} · near boundary ${n.nearBoundary}`);
  for (const row of c.cases) {
    const mark = MARKS[row.class] ?? (row.nearBoundary ? "~" : undefined);
    if (mark) lines.push(`  ${mark} ${caseLine(row)}${row.nearBoundary ? ` (near boundary: gap ${row.base.gap} → ${row.head.gap})` : ""}`);
  }
  return lines;
}

const MARKS: Partial<Record<CaseComparison["class"], string>> = { fixed: "✓", regressed: "✗", changed_unlabelled: "±", error: "!", missing: "?", escalated: "…" };

function caseLine(row: CaseComparison): string {
  const side = (s: CaseComparison["base"]) => (s.status === "scored" ? String(s.verdict) : s.status);
  return `${row.name ?? row.caseId}: ${side(row.base)} → ${side(row.head)}${row.expected !== undefined ? ` (expected ${row.expected})` : ""}`;
}

/** GitHub-flavoured Markdown for a PR comment or job summary: the verdict on top, case tables folded below. */
export function renderComparisonMarkdown(cmp: Comparison, title = "Verdict diff"): string {
  const icon = { rubric_change: "🔁", policy_change: "🎚️", same_conditions: "⏸", different_conditions: "⚠️" }[cmp.kind];
  const lines = [`### ${icon} ${title}: ${KIND_TEXT[cmp.kind]}`, "", `\`${cmp.base.rubricVersionId}\` → \`${cmp.head.rubricVersionId}\` · labels \`${cmp.labels.datasetVersionId}\``];
  const other = unexplainedDiffs(cmp);
  if (other.length) lines.push("", `Differs: ${other.map((d) => `\`${d.field}\``).join(", ")}. Results are not the rubric's alone.`);
  lines.push("", "| criterion | agreement | fixed | regressed | near boundary | errors · missing · asked a human | cases (both scored · labelled) |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cmp.criteria) lines.push(markdownRow(c));
  for (const c of cmp.criteria) lines.push(...markdownCases(c));
  return `${lines.join("\n")}\n`;
}

function markdownRow(c: CriterionComparison): string {
  const n = c.counts;
  const agreement = c.contract.same ? `${rate(c.agreement.base)} → ${rate(c.agreement.head)} (n=${c.agreement.n})` : "answer contract changed";
  return `| \`${c.criterionId}\` | ${agreement} | ${n.fixed} | ${n.regressed ? `**${n.regressed}**` : 0} | ${n.nearBoundary} | ${n.error} · ${n.missing} · ${n.escalated} | ${n.cases} (${n.commonSucceeded} · ${n.labelled}) |`;
}

function markdownCases(c: CriterionComparison): string[] {
  const shown = c.cases.filter((row) => !["kept_match", "kept_miss", "same_unlabelled"].includes(row.class) || row.nearBoundary);
  if (!shown.length) return [];
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = shown.map((row) => `| ${MARKS[row.class] ?? "~"} | ${cell(row.name ?? row.caseId)} | ${cell(sideText(row.base))} | ${cell(sideText(row.head))} | ${row.expected === undefined ? "" : cell(String(row.expected))} |`);
  return ["", `<details><summary><code>${c.criterionId}</code>: ${shown.length} case(s) that changed or need a look</summary>`, "", "| | case | base | head | expected |", "| --- | --- | --- | --- | --- |", ...rows, "", "</details>"];
}

const sideText = (s: CaseComparison["base"]) => (s.status === "scored" ? String(s.verdict) : s.status);
