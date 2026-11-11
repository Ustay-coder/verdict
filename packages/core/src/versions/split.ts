/**
 * Splits a rubric into the parts that change different things (docs/design/hub.md §5):
 * - judgment: what judges are asked — a change needs a re-run;
 * - policy: how answers are read (aggregation, weights, thresholds, escalation) — a change needs only re-scoring;
 * - binding: which model or service answers (provider, model, endpoint, options) — a change is a different condition;
 * - meta: names and descriptions used for search and display only.
 * A field belongs where it is actually used: decision questions never see the rubric name, LLM prompts do, so the
 * rubric name, version, description and language count as judgment only when an `llm` judge is present.
 */
import { criterionLevels } from "../judges/decision/questions.js";
import type { Criterion, JudgeSpec, Rubric } from "../schema/rubric.js";
import { criterionScale } from "../aggregate/index.js";

export interface RubricParts { judgment: unknown; policy: unknown; binding: unknown; meta: unknown }

type Json = Record<string, unknown>;
type JudgeParts = { judgment: Json; policy: Json; binding: Json };

// Fields that pick or configure the model; `apiKeyEnv` only names a secret and identifies nothing about the answer.
const BINDING = ["provider", "model", "baseUrl", "options", "effort", "samples"] as const;
// Fields that decide what happens with an answer, not what is asked.
const POLICY = ["minConfidence", "onLowConfidence", "escalateTo", "raters", "required"] as const;
const IGNORED = ["id", "apiKeyEnv"] as const;

/** One judge spec in three parts; panels split member by member so a member's model stays a binding. */
export function splitJudge(spec: JudgeSpec): JudgeParts {
  if (spec.type === "panel") {
    const members = spec.judges.map(splitJudge);
    return {
      judgment: { type: "panel", combine: spec.combine, judges: members.map((m) => m.judgment) },
      policy: { judges: members.map((m) => m.policy) },
      binding: { judges: members.map((m) => m.binding) },
    };
  }
  const parts: JudgeParts = { judgment: {}, policy: {}, binding: {} };
  for (const [key, value] of Object.entries(spec)) {
    if ((IGNORED as readonly string[]).includes(key)) continue;
    const bucket = (BINDING as readonly string[]).includes(key) ? parts.binding : (POLICY as readonly string[]).includes(key) ? parts.policy : parts.judgment;
    bucket[key] = value;
  }
  return parts;
}

/** Every judge a rubric can use, keyed by where it is declared. */
function judgeSlots(rubric: Rubric): Array<[string, JudgeSpec]> {
  const slots: Array<[string, JudgeSpec]> = [["defaultJudge", rubric.defaultJudge]];
  for (const [name, spec] of Object.entries(rubric.judges)) slots.push([`judges.${name}`, spec]);
  if (rubric.checksJudge) slots.push(["checksJudge", rubric.checksJudge]);
  for (const c of rubric.criteria) {
    const specs = Array.isArray(c.judge) ? c.judge : c.judge ? [c.judge] : [];
    specs.forEach((spec, i) => slots.push([`criteria.${c.id}.judge[${i}]`, spec]));
  }
  return slots;
}

function usesLlm(spec: JudgeSpec): boolean {
  return spec.type === "llm" || (spec.type === "panel" && spec.judges.some(usesLlm));
}

function criterionJudgment(c: Criterion): Json {
  const { weight: _w, threshold: _t, values: _v, optional: _o, group: _g, rater: _r, judge: _j, ...asked } = c;
  return asked;
}

function criterionPolicy(c: Criterion): Json {
  return { id: c.id, weight: c.weight, threshold: c.threshold, values: c.values, optional: c.optional, rater: c.rater };
}

/** The four parts of a parsed rubric. Inputs are plain JSON, so each part hashes deterministically. */
export function splitRubric(rubric: Rubric): RubricParts {
  const slots = judgeSlots(rubric).map(([where, spec]) => [where, splitJudge(spec)] as const);
  const llm = judgeSlots(rubric).some(([, spec]) => usesLlm(spec));
  const prompted = { name: rubric.name, version: rubric.version, description: rubric.description, language: rubric.language };
  return {
    judgment: {
      context: rubric.context,
      scale: rubric.scale,
      inputSchema: rubric.inputSchema,
      checks: rubric.checks?.map(({ id, question, criteria }) => ({ id, question, criteria })),
      criteria: rubric.criteria.map(criterionJudgment),
      judges: Object.fromEntries(slots.map(([where, p]) => [where, p.judgment])),
      ...(llm ? { prompted } : {}),
    },
    policy: {
      aggregation: rubric.aggregation,
      criteria: rubric.criteria.map(criterionPolicy),
      checks: rubric.checks?.map(({ id, expect, threshold, action, message }) => ({ id, expect, threshold, action, message })),
      judges: Object.fromEntries(slots.map(([where, p]) => [where, p.policy])),
    },
    binding: { judges: Object.fromEntries(slots.map(([where, p]) => [where, p.binding])) },
    meta: { ...(llm ? {} : prompted), metadata: rubric.metadata, groups: rubric.criteria.map((c) => ({ id: c.id, group: c.group })) },
  };
}

/**
 * What a criterion's answer means: its question type and the ordered levels or options it answers with. Two versions
 * whose contracts differ cannot be compared on raw values (a "2" on one level set is not a "2" on another).
 */
export interface OutputContract { type: "score" | "noul" | "choice"; levels?: Array<{ value: number; label: string }>; options?: string[] }

export function outputContract(rubric: Rubric, criterion: Criterion): OutputContract {
  if (criterion.choices) return { type: "choice", options: Object.keys(criterion.choices) };
  const scale = criterionScale(rubric, criterion);
  const levels = criterionLevels(rubric, criterion, scale).map(({ value, label }) => ({ value, label }));
  return { type: scale.type === "binary" ? "noul" : "score", levels };
}
