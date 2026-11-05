import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Scales                                                              */
/* ------------------------------------------------------------------ */

export const NumericScale = z.object({
  type: z.literal("numeric"),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
});

export const BinaryScale = z.object({
  type: z.literal("binary"),
  /** Labels for 0 / 1, e.g. ["fail", "pass"]. */
  labels: z.tuple([z.string(), z.string()]).optional(),
});

export const OrdinalScale = z.object({
  type: z.literal("ordinal"),
  /** Ordered from worst to best. Index = numeric value unless `values` given. */
  labels: z.array(z.string()).min(2),
  values: z.array(z.number()).optional(),
});

export const Scale = z.discriminatedUnion("type", [NumericScale, BinaryScale, OrdinalScale]);
export type Scale = z.infer<typeof Scale>;

/* ------------------------------------------------------------------ */
/* Judges                                                              */
/* ------------------------------------------------------------------ */

export const LlmProvider = z.enum(["anthropic", "openai", "cloudflare", "http", "mock"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const LlmJudgeSpec = z.object({
  type: z.literal("llm"),
  id: z.string().optional(),
  provider: LlmProvider.default("anthropic"),
  model: z.string().optional(),
  /** Reasoning effort for providers that support it (Anthropic). */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Extra instructions appended to the judge system prompt. */
  instructions: z.string().optional(),
  /** Self-consistency: sample N times and take the median. */
  samples: z.number().int().min(1).max(15).default(1),
  /** For provider=http or openai-compatible: endpoint base URL. */
  baseUrl: z.string().url().optional(),
  /** Env var name holding the API key (never put secrets in rubrics). */
  apiKeyEnv: z.string().optional(),
  /** Arbitrary provider options passed through verbatim. */
  options: z.record(z.string(), z.unknown()).optional(),
});

export const HumanJudgeSpec = z.object({
  type: z.literal("human"),
  id: z.string().optional(),
  /** Who may submit a score. Empty = anyone with an API key for the tenant. */
  raters: z.array(z.string()).default([]),
  /** How many independent ratings are required before the criterion is final. */
  required: z.number().int().min(1).default(1),
  /** Shown to the human rater. */
  instructions: z.string().optional(),
});

export const BenchmarkMethod = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("regex"),
    pattern: z.string(),
    flags: z.string().optional(),
    /** If set, score = min(count * perMatch, 1). Otherwise any match = full score. */
    perMatch: z.number().positive().optional(),
    /** Invert: a match means failure. */
    negate: z.boolean().default(false),
  }),
  z.object({
    method: z.literal("keywords"),
    keywords: z.array(z.string()).min(1),
    mode: z.enum(["all", "any", "ratio"]).default("ratio"),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    method: z.literal("length"),
    unit: z.enum(["words", "chars", "lines"]).default("words"),
    min: z.number().optional(),
    max: z.number().optional(),
    /** How far outside [min,max] (as a fraction of the range) before the score hits 0. */
    tolerance: z.number().min(0).default(0.5),
  }),
  z.object({
    method: z.literal("jsonpath"),
    /** Dotted path into the first JSON input (or the input tagged via `input`). */
    path: z.string(),
    input: z.string().optional(),
    /** Map arbitrary values to a normalized 0..1 score. Numbers are used as-is unless `range` given. */
    map: z.record(z.string(), z.number()).optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
  }),
  z.object({
    method: z.literal("formula"),
    /** Expression over evidence stats (words, chars, lines, inputs) and JSON fields. Must yield 0..1. */
    expression: z.string(),
  }),
  z.object({
    method: z.literal("similarity"),
    /** Reference answer; score = cosine similarity over token bags. */
    reference: z.string(),
    /** Only count the reference as matched when similarity >= threshold (binary). */
    threshold: z.number().min(0).max(1).optional(),
  }),
  z.object({
    method: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    apiKeyEnv: z.string().optional(),
  }),
]);
export type BenchmarkMethod = z.infer<typeof BenchmarkMethod>;

export const BenchmarkJudgeSpec = z
  .object({ type: z.literal("benchmark"), id: z.string().optional() })
  .and(BenchmarkMethod);

export const PanelCombine = z.enum(["mean", "median", "min", "max", "majority"]);

export type JudgeSpec =
  | z.infer<typeof LlmJudgeSpec>
  | z.infer<typeof HumanJudgeSpec>
  | z.infer<typeof BenchmarkJudgeSpec>
  | { type: "panel"; id?: string; judges: JudgeSpec[]; combine: z.infer<typeof PanelCombine> }
  | { type: "ref"; ref: string };

export const JudgeSpec: z.ZodType<JudgeSpec> = z.lazy(() =>
  z.union([
    LlmJudgeSpec,
    HumanJudgeSpec,
    BenchmarkJudgeSpec,
    z.object({
      type: z.literal("panel"),
      id: z.string().optional(),
      judges: z.array(JudgeSpec).min(1),
      combine: PanelCombine.default("mean"),
    }),
    /** Reference a judge declared in `rubric.judges` by name. */
    z.object({ type: z.literal("ref"), ref: z.string() }),
  ]),
) as z.ZodType<JudgeSpec>;

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export const RaterAggregation = z.enum(["mean", "median", "trimmed_mean", "min", "max", "majority"]);
export type RaterAggregation = z.infer<typeof RaterAggregation>;

export const Gate = z.object({
  criterion: z.string(),
  /** Thresholds in the criterion's own units. */
  min: z.number().optional(),
  max: z.number().optional(),
  message: z.string().optional(),
});

export const Grade = z.object({ label: z.string(), min: z.number() });

export const Aggregation = z.object({
  method: z
    .enum(["weighted_mean", "weighted_sum", "mean", "median", "min", "max", "geometric_mean", "formula"])
    .default("weighted_mean"),
  /** For method=formula. Variables: `<criterionId>` (raw), `<criterionId>_n` (0..1), `<criterionId>_w` (weight). */
  formula: z.string().optional(),
  /** Default rater aggregation for criteria with multiple ratings. */
  rater: RaterAggregation.default("mean"),
  /** Output range. Default 0..100. `false` keeps the method's natural units. */
  normalize: z.union([z.literal(false), z.tuple([z.number(), z.number()])]).default([0, 100]),
  /** How to treat criteria with no score yet / excluded: */
  missing: z.enum(["exclude", "zero", "fail"]).default("exclude"),
  /** Hard gates — failing any sets passed=false regardless of total. */
  gates: z.array(Gate).default([]),
  /** Letter grades / tiers on the normalized score. Highest `min` wins. */
  grades: z.array(Grade).optional(),
  /** Pass if normalized total >= threshold (and all gates pass). */
  passThreshold: z.number().optional(),
  /** Decimal places for the final score. */
  precision: z.number().int().min(0).max(6).default(2),
});
export type Aggregation = z.infer<typeof Aggregation>;

/* ------------------------------------------------------------------ */
/* Criteria & Rubric                                                   */
/* ------------------------------------------------------------------ */

export const Criterion = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "criterion id must be an identifier (letters, digits, _)"),
  name: z.string(),
  description: z.string().optional(),
  weight: z.number().min(0).default(1),
  scale: Scale.optional(),
  /** Descriptions of what each level looks like, keyed by score or label. Strongly improves LLM judges. */
  anchors: z.record(z.string(), z.string()).optional(),
  /** Judge(s) for this criterion; falls back to rubric.defaultJudge. Multiple = independent ratings. */
  judge: z.union([JudgeSpec, z.array(JudgeSpec)]).optional(),
  /** Rater aggregation override for this criterion. */
  rater: RaterAggregation.optional(),
  /** Restrict evidence to inputs carrying one of these tags. */
  inputs: z.array(z.string()).optional(),
  /** Optional criterion: missing score is excluded instead of failing. */
  optional: z.boolean().default(false),
  /** Group label for reporting (e.g. "Technical", "Business"). */
  group: z.string().optional(),
});
export type Criterion = z.infer<typeof Criterion>;

export const Rubric = z.object({
  id: z.string().optional(),
  name: z.string(),
  version: z.string().default("1"),
  description: z.string().optional(),
  /** Context given to every judge: what is being evaluated and why. */
  context: z.string().optional(),
  /** Output language for rationales (BCP-47), e.g. "en", "ko". Default: follow the input. */
  language: z.string().optional(),
  scale: Scale.default({ type: "numeric", min: 0, max: 10 }),
  judges: z.record(z.string(), JudgeSpec).default({}),
  defaultJudge: JudgeSpec.default({ type: "llm", provider: "anthropic", samples: 1 } as JudgeSpec),
  criteria: z.array(Criterion).min(1),
  aggregation: Aggregation.prefault({}),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Rubric = z.infer<typeof Rubric>;
export type RubricInput = z.input<typeof Rubric>;

/** Parse + validate a rubric, filling defaults and checking cross-references. */
export function parseRubric(input: unknown): Rubric {
  const parsed = Rubric.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid rubric: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  }
  const rubric = parsed.data;
  const ids = new Set<string>();
  for (const c of rubric.criteria) {
    if (ids.has(c.id)) throw new Error(`duplicate criterion id: ${c.id}`);
    ids.add(c.id);
  }
  for (const g of rubric.aggregation.gates) {
    if (!ids.has(g.criterion)) throw new Error(`gate references unknown criterion: ${g.criterion}`);
  }
  if (rubric.aggregation.method === "formula" && !rubric.aggregation.formula) {
    throw new Error("aggregation.method=formula requires aggregation.formula");
  }
  const checkRef = (j: JudgeSpec, where: string) => {
    if (j.type === "ref" && !rubric.judges[j.ref]) throw new Error(`${where}: unknown judge ref "${j.ref}"`);
    if (j.type === "panel") j.judges.forEach((s, i) => checkRef(s, `${where}.judges[${i}]`));
  };
  checkRef(rubric.defaultJudge, "defaultJudge");
  for (const c of rubric.criteria) {
    const js = Array.isArray(c.judge) ? c.judge : c.judge ? [c.judge] : [];
    js.forEach((j, i) => checkRef(j, `criteria.${c.id}.judge[${i}]`));
  }
  return rubric;
}
