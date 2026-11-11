/**
 * Constructs judge implementations and combines panel member ratings.
 * Pending humans must remain visible through panels; member failures cannot silently become scores.
 */
import type { JudgeSpec, Rubric } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { aggregateNumbers, denormalizeScore, normalizeScore } from "../aggregate/index.js";
import { BenchmarkJudge } from "./benchmark.js";
import { HumanJudge } from "./human.js";
import { LlmJudge } from "./llm.js";
import { DecisionJudge } from "./decision.js";
import { type Judge, type JudgeContext, ratingBase } from "./types.js";

export * from "./types.js";
export * from "./decision.js";
export * from "./llm.js";
export * from "./benchmark.js";
export * from "./human.js";

/** Runs several judges and folds their scored ratings into one. Pending (human) members keep the panel pending. */
export class PanelJudge implements Judge {
  readonly type = "panel" as const;
  readonly id: string;
  constructor(public members: Judge[], public combine: "mean" | "median" | "min" | "max" | "majority", id?: string) {
    this.id = id ?? `panel(${members.map((m) => m.id).join("+")})`;
  }
  expectedRatings() { return 1; }
  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const all = (await Promise.all(this.members.map((m) => m.rate(ctx)))).flat();
    const base = ratingBase(ctx, this);
    const scored = all.filter((r) => r.status === "scored");
    const pending = all.filter((r) => r.status === "pending");
    if (pending.length) return [{ ...base, status: "pending", raw: { members: all } }, ...pending];
    if (!scored.length) return [{ ...base, status: "error", error: all.map((r) => r.error).filter(Boolean).join("; ") || "no member produced a score", raw: { members: all } }];
    const n = aggregateNumbers(scored.map((r) => r.normalized!), this.combine)!;
    const score = denormalizeScore(n, ctx.scale);
    return [{
      ...base,
      status: "scored",
      score,
      normalized: normalizeScore(score, ctx.scale),
      confidence: scored.reduce((s, r) => s + (r.confidence ?? 0.5), 0) / scored.length,
      rationale: scored.map((r) => `[${r.raterId}: ${r.score}] ${r.rationale ?? ""}`).join(" | "),
      quotes: scored.flatMap((r) => r.quotes ?? []).slice(0, 5),
      raw: { members: all, combine: this.combine },
    }];
  }
}

/** Custom judge factories can be registered to extend the `type` discriminator (e.g. "my_decision_ai"). */
const customFactories = new Map<string, (spec: Record<string, unknown>, rubric: Rubric) => Judge>();
/** Registers or replaces a custom judge factory; factory failures propagate when that judge is built. */
export function registerJudgeType(type: string, factory: (spec: Record<string, unknown>, rubric: Rubric) => Judge) { customFactories.set(type, factory); }

/** Constructs a judge from its spec; throws for unknown types or unresolved references. */
export function buildJudge(spec: JudgeSpec, rubric: Rubric): Judge {
  switch (spec.type) {
    case "ref": {
      const target = rubric.judges[spec.ref];
      if (!target) throw new Error(`unknown judge ref "${spec.ref}"`);
      const j = buildJudge(target, rubric);
      return Object.assign(Object.create(Object.getPrototypeOf(j)), j, { id: spec.ref });
    }
    case "decision": return new DecisionJudge(spec);
    case "llm": return new LlmJudge(spec);
    case "human": return new HumanJudge(spec);
    case "benchmark": return new BenchmarkJudge(spec);
    case "panel": return new PanelJudge(spec.judges.map((s) => buildJudge(s, rubric)), spec.combine, spec.id);
    default: {
      const t = (spec as { type: string }).type;
      const f = customFactories.get(t);
      if (!f) throw new Error(`unknown judge type "${t}"`);
      return f(Object.assign({}, spec), rubric);
    }
  }
}
