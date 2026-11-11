import type { Criterion, Rubric, Scale } from "../../schema/rubric.js";
import { scaleRange } from "../../aggregate/index.js";
import type { JudgeContext } from "../types.js";
import type { SystemOneQuestion } from "./contracts.js";

// Jev score questions accept 2–10 ordered levels; extra numeric anchors are capped for wire compatibility.
const MIN_DECISION_LEVELS = 2;
const MAX_DECISION_LEVELS = 10;

export interface Level { value: number; label: string; description: string }

/** Returns ascending rubric levels; expects a validated scale and does not perform I/O. */
export function criterionLevels(rubric: Rubric, c: Criterion, scale: Scale = c.scale ?? rubric.scale): Level[] {
  // why: explicit levels override generated anchors; ordered values determine score interpolation.
  if (c.levels?.length) return c.levels.map((l) => ({ value: l.value, label: l.label ?? String(l.value), description: l.description })).sort((a, b) => a.value - b.value);
  if (scale.type === "ordinal") {
    const vals = scale.values ?? scale.labels.map((_, i) => i);
    return scale.labels.map((label, i) => ({ value: vals[i]!, label, description: c.anchors?.[label] ?? c.anchors?.[String(vals[i])] ?? label }));
  }
  if (scale.type === "binary") {
    const [no, yes] = scale.labels ?? ["no", "yes"];
    return [
      { value: 0, label: no, description: c.anchors?.[no] ?? c.anchors?.["0"] ?? `${c.name}: ${no}` },
      { value: 1, label: yes, description: c.anchors?.[yes] ?? c.anchors?.["1"] ?? `${c.name}: ${yes}` },
    ];
  }
  // why: only numeric anchor keys define numeric levels; fewer than two usable anchors require generated endpoints.
  const anchored = Object.entries(c.anchors ?? {})
    .map(([k, d]) => ({ value: Number(k), label: k, description: d }))
    .filter((l) => Number.isFinite(l.value))
    .sort((a, b) => a.value - b.value);
  if (anchored.length >= MIN_DECISION_LEVELS) return anchored.slice(0, MAX_DECISION_LEVELS);
  const [lo, hi] = scaleRange(scale);
  const n = scale.step ? Math.min(MAX_DECISION_LEVELS, Math.max(MIN_DECISION_LEVELS, Math.round((hi - lo) / scale.step) + 1)) : Math.min(MAX_DECISION_LEVELS, Math.max(MIN_DECISION_LEVELS, Math.round(hi - lo) + 1));
  const words = ["very poor", "poor", "below average", "average", "above average", "good", "very good", "excellent", "outstanding", "perfect"];
  return Array.from({ length: n }, (_, i) => {
    const value = lo + ((hi - lo) * i) / (n - 1);
    const w = words[Math.round((i / (n - 1)) * (words.length - 1))]!;
    return { value: Number(value.toFixed(3)), label: String(Number(value.toFixed(3))), description: `${c.name} is ${w}${c.description ? ` (${c.description})` : ""}` };
  });
}

/**
 * Version of the rubric → question translation below. Bump it whenever `buildQuestion` or `criterionLevels` would
 * send different text or levels for the same rubric: run records carry it, so a comparison can tell a rubric edit
 * apart from a change in how Verdict phrases the question.
 */
export const QUESTION_FORMAT_VERSION = "decision-questions@1";

/** Builds one provider question from validated criterion levels; does not perform I/O. */
export function buildQuestion(ctx: JudgeContext, levels: Level[], extra?: string): SystemOneQuestion {
  const { rubric, criterion } = ctx;
  const head = [
    rubric.context ? `Context: ${rubric.context}` : undefined,
    `Criterion "${criterion.name}"${criterion.description ? `: ${criterion.description}` : ""}.`,
    extra,
  ].filter(Boolean).join(" ");
  if (criterion.choices) return { type: "choice", instructions: head, criteria: criterion.choices };
  if (ctx.scale.type === "binary") {
    const [no, yes] = levels;
    return { type: "noul", instructions: `${head} Is the input "${yes!.label}" for this criterion?`, criteria: { true: yes!.description, false: no!.description } };
  }
  return {
    type: "score",
    instructions: `${head} Place the input on the ordered levels below (worst to best). Judge only this criterion using the evidence in the state.`,
    criteria: levels.map((l) => `${l.label}: ${l.description}`),
  };
}
