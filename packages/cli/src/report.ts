/**
 * Formats evaluation results for terminal readers.
 * Missing scores stay visibly absent; rendering never changes the persisted evaluation.
 */
import { type Evaluation } from "@verdict-ai/core";

/** Formats a number or returns an em dash when absent; invalid precision throws RangeError. */
export function fmt(n: number | undefined, p = 1) { return n === undefined ? "—" : n.toFixed(p); }

// why: cap supporting prose for readable terminal rows while retaining full rationales in JSON.
const MAX_RATIONALE_CHARS = 160;
const MIN_NAME_WIDTH = 8;

type ReportEvaluation = Omit<Evaluation, "rubric" | "evidence"> & { rubric: { name: string } };

/** Renders an evaluation without I/O; missing scores remain explicit in the report. */
export function renderReport(ev: ReportEvaluation): string {
  const lines: string[] = [];
  const a = ev.aggregate;
  lines.push(`${ev.rubric.name}${ev.subject.name ? ` — ${ev.subject.name}` : ""}`);
  lines.push(`status: ${ev.status}${a.partial ? " (provisional)" : ""}   id: ${ev.id}`);
  lines.push(`score: ${fmt(a.score, 2)}${a.range ? ` / ${a.range[1]}` : ""}${a.grade ? `   grade: ${a.grade}` : ""}${a.passed !== undefined ? `   ${a.passed ? "PASS" : "FAIL"}` : ""}`);
  lines.push("");
  const w = Math.max(...ev.criteria.map((c) => c.name.length), MIN_NAME_WIDTH);
  for (const c of ev.criteria) lines.push(...renderCriterion(c, w));
  if (ev.pendingTasks.length) { lines.push(""); lines.push(`waiting on humans: ${ev.pendingTasks.map((t) => `${t.criterionId} (${t.raterId ?? (t.allowedRaters ? `one of ${t.allowedRaters.join("|")}` : "anyone")})`).join(", ")}`); lines.push(`  submit with: verdict score ${ev.id} <criterionId> --rater <id> --score <n>`); }
  if (ev.error) lines.push(`error: ${ev.error}`);
  lines.push("");
  lines.push(`decision calls: ${ev.usage.decisionCalls}  llm calls: ${ev.usage.llmCalls}  tokens in/out: ${ev.usage.inputTokens}/${ev.usage.outputTokens}  ${ev.usage.durationMs}ms`);
  return lines.join("\n");
}

function renderCriterion(c: Evaluation["criteria"][number], w: number): string[] {
  const lines: string[] = [];
  const s = c.choice ? `${c.criterionId}: ${c.choice} (${fmt((c.choices?.[c.choice] ?? 0) * 100, 0)}%)` : typeof c.score === "number" ? `${fmt(c.score, 2)} (${fmt((c.normalized ?? 0) * 100, 0)}%)` : c.status;
  lines.push(`  ${c.name.padEnd(w)}  w=${c.weight}  ${s}${c.pending ? `  [${c.pending} pending]` : ""}${c.gate && !c.gate.passed ? "  GATE FAILED" : ""}`);
  // why: show one supporting rationale to keep multi-rater reports compact; every error is still shown below.
  const r = c.ratings.find((x) => x.rationale);
  if (r?.rationale) lines.push(`  ${"".padEnd(w)}  ${r.rationale.replace(/\s+/g, " ").slice(0, MAX_RATIONALE_CHARS)}${typeof r.confidence === "number" ? `  [conf ${r.confidence.toFixed(2)}]` : ""}`);
  for (const e of c.ratings.filter((x) => x.status === "error")) lines.push(`  ${"".padEnd(w)}  error(${e.raterId}): ${e.error}`);
  return lines;
}
