/**
 * The side-by-side table of `verdict run --models`: one row per model, then every case the models split on. Rates are
 * printed with their denominators, and what was not measured is a dash rather than a zero. The number beside an
 * answer is the probability the model gave it. It is not the provider's `confidence`: providers compute that three
 * different ways, so side by side it would compare nothing (`--json` has both).
 */
import type { ModelComparison, ModelRow, ModelSplit } from "@verdict-ai/core";

const count = (n: number) => n.toLocaleString("en-US");
const rate = (r: ModelRow) => (r.labelled.n ? `${r.labelled.agreed}/${r.labelled.n} (${Math.round(r.labelled.agreement! * 100)}%)` : "—");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const answeredBy = (r: ModelRow) => r.models.map((m) => `${m.provider}/${m.resolved ?? m.requested ?? "default"}`).join(", ") || "—";

/** Columns padded to their widest cell, so the table reads in any terminal. */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((r) => r[column]!.length)));
  return rows.map((r) => `  ${r.map((cell, column) => cell.padEnd(widths[column]!)).join("   ").trimEnd()}`);
}

function splitLine(split: ModelSplit, many: boolean): string {
  const probability = (p: number | null) => (p === null ? "" : ` (${p.toFixed(2)})`);
  const given = split.answers.map((a) => `${a.label} ${a.shown}${probability(a.probability)}`).join(" | ");
  return `  ${split.name}${many ? ` · ${split.criterionId}` : ""}   ${split.expected ? `expected ${split.expected.shown}   ` : ""}${given}`;
}

export function renderModels(cmp: ModelComparison, criteria: number): string[] {
  const asked = cmp.sameQuestions ? "the same questions to each" : "the questions sent were not the same for every model: read the rows with that in mind";
  const lines = [`${cmp.rubric} × ${cmp.dataset}: ${cmp.cases} case(s), ${cmp.models.length} model(s), ${asked}`];
  lines.push(...table([
    ["model", "answered by", "agreed with labels", "failed", "asked a human", "input tokens", "calls", "time"],
    ...cmp.models.map((r) => [r.label, answeredBy(r), rate(r), String(r.counts.failed), String(r.counts.pendingHuman), count(r.usage.inputTokens), String(r.usage.decisionCalls), seconds(r.durationMs)]),
  ]));
  // A provider's refusal can be a page of JSON; one line says enough to act on, and --json has all of it.
  const brief = (text: string) => (text.replace(/\s+/g, " ").length > 200 ? `${text.replace(/\s+/g, " ").slice(0, 200)}…` : text.replace(/\s+/g, " "));
  for (const r of cmp.models) if (r.error) lines.push(`  ${r.label} failed: ${brief(r.error)}`);
  const answering = cmp.models.filter((r) => r.status !== "failed").length;
  if (answering > 1) {
    lines.push(cmp.splits.length
      ? `the models gave one answer on ${cmp.unanimous} of ${cmp.answered} question(s) they all answered; they differ on ${cmp.splits.length}:`
      : `the models gave one answer on all ${cmp.answered} question(s) they answered`);
    lines.push(...cmp.splits.map((s) => splitLine(s, criteria > 1)));
  }
  return lines;
}
