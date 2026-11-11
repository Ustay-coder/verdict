/**
 * Combines generative judgement samples into a single criterion rating.
 * Provider failures become error ratings; disagreement can only reduce reported confidence.
 */
import { parseProvider, ProviderError } from "../../provider-error.js";
import { JudgementSchema } from "./contracts.js";
import { median, normalizeScore, scaleRange, snapToScale } from "../../aggregate/index.js";
import type { Rating } from "../../schema/evaluation.js";
import { type Judge, type JudgeContext, ratingBase, renderEvidence } from "../types.js";

import { type LlmProviderAdapter, type LlmRequest, type LlmResponse, type Spec } from "./contracts.js";
import { buildSystemPrompt } from "./prompt.js";
import { getLlmProvider } from "./registry.js";
// Bound generated rationale cost and retained evidence independently of the provider context window.
const MAX_JUDGEMENT_TOKENS = 4000;
const MAX_SUPPORTING_QUOTES = 5;

/** Combines validated LLM samples; rate returns an error rating when provider or judgement validation fails. */
export class LlmJudge implements Judge {
  readonly type = "llm" as const;
  readonly id: string;
  constructor(public spec: Spec) { this.id = spec.id ?? `llm:${spec.provider}${spec.model ? `/${spec.model}` : ""}`; }
  expectedRatings() { return 1; }

  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const base = ratingBase(ctx, this);
    const started = (ctx.now ?? Date.now)();
    let provider: LlmProviderAdapter;
    try { provider = getLlmProvider(this.spec.provider); } catch (e) { return [{ ...base, status: "error", error: (e as Error).message }]; }
    const req: LlmRequest = {
      system: buildSystemPrompt(ctx, this.spec.instructions),
      user: `Evaluate the following inputs for the criterion "${ctx.criterion.name}".\n\n${renderEvidence(ctx.evidence)}`,
      model: this.spec.model,
      effort: this.spec.effort,
      maxTokens: MAX_JUDGEMENT_TOKENS,
      options: this.spec.options,
      baseUrl: this.spec.baseUrl,
      apiKey: this.spec.apiKeyEnv ? ctx.env(this.spec.apiKeyEnv) : undefined,
    };
    try {
      if (this.spec.apiKeyEnv && !req.apiKey) throw new ProviderError(provider.name, `missing credential: ${this.spec.apiKeyEnv}`);
      // why: samples are independent and share the injected transport; any invalid sample fails this rating as a unit.
      const samples = await Promise.all(Array.from({ length: this.spec.samples }, () => provider.complete(req, ctx)));
      for (const s of samples) {
        s.judgement = parseProvider(provider.name, JudgementSchema, s.judgement);
        ctx.usage.llmCalls++;
        ctx.usage.inputTokens += s.usage?.inputTokens ?? 0;
        ctx.usage.outputTokens += s.usage?.outputTokens ?? 0;
      }
      if (ctx.criterion.choices) return choiceRating(ctx, samples, base);
      return scoreRating(ctx, samples, base, { provider: provider.name, model: this.spec.model, latencyMs: (ctx.now ?? Date.now)() - started });
    } catch (e) {
      return [{ ...base, status: "error", error: (e as Error).message, raw: { provider: provider.name, latencyMs: (ctx.now ?? Date.now)() - started } }];
    }
  }
}

// Choice votes use declaration order to break ties so identical samples always produce the same answer.
function choiceRating(ctx: JudgeContext, samples: LlmResponse[], base: Omit<Rating<"llm">, "status">): Rating[] {
  const options = Object.keys(ctx.criterion.choices!);
  for (const s of samples) if (!s.judgement.choice || !Object.hasOwn(ctx.criterion.choices!, s.judgement.choice)) throw new Error("invalid LLM choice");
  const counts = options.map(o => samples.filter(s => s.judgement.choice === o).length);
  const choice = options[counts.indexOf(Math.max(...counts))]!;
  const best = samples.find(s => s.judgement.choice === choice)!;
  const score = ctx.criterion.values?.[choice];
  return [{ ...base, status: "scored", choice, score, normalized: score === undefined ? undefined : normalizeScore(score, ctx.scale), confidence: best.judgement.confidence, rationale: best.judgement.rationale, quotes: best.judgement.quotes, probabilities: Object.fromEntries(options.map((o, i) => [o, counts[i]! / samples.length])) }];
}

// The nearest sample supplies rationale; disagreement may lower confidence but cannot increase it.
function scoreRating(ctx: JudgeContext, samples: LlmResponse[], base: Omit<Rating<"llm">, "status">, metadata: { provider: string; model?: string; latencyMs: number }): Rating[] {
  const scores = samples.map((s) => snapToScale(s.judgement.score, ctx.scale));
  const score = samples.length === 1 ? scores[0]! : snapToScale(median([...scores].sort((a, b) => a - b)), ctx.scale);
  const best = samples.reduce((a, b) => (Math.abs(a.judgement.score - score) <= Math.abs(b.judgement.score - score) ? a : b));
  const agreement = samples.length > 1 ? 1 - (Math.max(...scores) - Math.min(...scores)) / (scaleRange(ctx.scale)[1] - scaleRange(ctx.scale)[0] || 1) : undefined;
  return [{
    ...base,
    status: "scored",
    score,
    normalized: normalizeScore(score, ctx.scale),
    confidence: agreement !== undefined ? Math.min(best.judgement.confidence, agreement) : best.judgement.confidence,
    rationale: best.judgement.rationale,
    quotes: best.judgement.quotes.slice(0, MAX_SUPPORTING_QUOTES),
    raw: { ...metadata, model: best.model ?? metadata.model, samples: scores, agreement },
  }];
}
