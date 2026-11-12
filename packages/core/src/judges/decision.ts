/**
 * Maps criterion scales to System One questions and provider answers to ratings.
 * All criteria sharing evidence and judge settings use one request; uncertainty retains its distribution.
 */
import { parseProvider, ProviderError, SystemOneAnswerSchema } from "../provider-error.js";
import { z } from "zod";
import { getDecisionProvider, type DecisionProviderAdapter, type DecisionResponse, type SystemOneQuestion } from "./decision/contracts.js";
export * from "./decision/contracts.js";
export { checkClefImages, CLEF_LIMITS } from "./decision/images.js";
import { registerBuiltInDecisionProviders } from "./decision/providers.js";
import type { DecisionJudgeSpec as DecisionSpecSchema } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { escalateDecision } from "./decision/escalation.js";
import { criterionLevels, buildQuestion } from "./decision/questions.js";
import { answerToScore, answerToChoice, DEFAULT_BINARY_THRESHOLD } from "./decision/answers.js";
export { criterionLevels, buildQuestion, type Level } from "./decision/questions.js";
export { answerToScore, binaryMargin, DEFAULT_BINARY_THRESHOLD } from "./decision/answers.js";
import { type Judge, type JudgeContext, ratingBase, renderEvidence } from "./types.js";
import { evidenceImages } from "../ingest/images.js";
import { describeDocuments, evidenceDocuments } from "../ingest/documents.js";
import type { Evidence } from "../schema/subject.js";

registerBuiltInDecisionProviders();

type Spec = z.infer<typeof DecisionSpecSchema>;

/**
 * Conservative state budgets (chars ≈ tokens × 4) so a request never exceeds the model's context window:
 * Jev: 64k/request, 32k for state + longest question. Clef: 65,536. Clef-flash: 24,576. Room is left for questions.
 */
const CHARS_PER_TOKEN = 4;
const STATE_TOKEN_BUDGET = { clefFlash: 18_000, cloudflare: 50_000, systemOne: 28_000 };

function defaultStateCharLimit(provider: string, model?: string): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("clef-flash")) return STATE_TOKEN_BUDGET.clefFlash * CHARS_PER_TOKEN;
  if (provider === "cloudflare") return STATE_TOKEN_BUDGET.cloudflare * CHARS_PER_TOKEN;
  return STATE_TOKEN_BUDGET.systemOne * CHARS_PER_TOKEN; // Jev and System One-compatible hosts
}

/**
 * The state a provider is sent. A provider that reads PDFs itself is sent the file, so the state names the file
 * instead of repeating its text layer; every other provider is given the text.
 */
function stateFor(evidence: Evidence[], provider: DecisionProviderAdapter): string {
  if (!provider.acceptsDocuments) return renderEvidence(evidence);
  return renderEvidence(evidence.map((e) => (evidenceDocuments(e).length ? { ...e, text: describeDocuments(e) } : e)));
}

/** Batches compatible criteria into one provider call; rate methods return error ratings on failure. */
export class DecisionJudge implements Judge {
  readonly type = "decision" as const;
  readonly id: string;
  constructor(public spec: Spec) { this.id = spec.id ?? `decision:${spec.provider}${spec.model ? `/${spec.model}` : ""}`; }
  expectedRatings() { return 1; }
  /** Only judges with an identical spec share a request (model, thresholds, options, ...). */
  batchKey() { return `decision|${JSON.stringify(this.spec)}`; }

  async ask(ctx: JudgeContext, questions: Record<string, SystemOneQuestion>): Promise<DecisionResponse> {
    try { return await this.requestAnswers(ctx, questions); }
    catch (cause) {
      // Custom adapters need the same operation context as built-in providers.
      if (cause instanceof ProviderError && cause.message.startsWith(`${cause.provider}: decide:`)) throw cause;
      const detail = cause instanceof ProviderError ? cause.message.slice(cause.provider.length + 2) : cause instanceof Error ? cause.message : String(cause);
      throw new ProviderError(this.spec.provider, `decide: ${detail}`, cause instanceof ProviderError ? cause.status : undefined, { cause });
    }
  }

  private async requestAnswers(ctx: JudgeContext, questions: Record<string, SystemOneQuestion>): Promise<DecisionResponse> {
    const provider = getDecisionProvider(this.spec.provider);
    if (this.spec.apiKeyEnv && !ctx.env(this.spec.apiKeyEnv)) throw new ProviderError(provider.name, `decide: missing credential: ${this.spec.apiKeyEnv}`);
    const limit = this.stateCharLimit();
    const { stateCharLimit: _limit, ...options } = this.spec.options ?? {};
    // why: text-only providers would reject or ignore image payloads; send only what the adapter declares it can take.
    const attached = ctx.evidence.flatMap(evidenceImages);
    const images = provider.acceptsImages ? attached.slice(0, provider.maxImages ?? attached.length) : [];
    const files = ctx.evidence.flatMap(evidenceDocuments);
    const documents = provider.acceptsDocuments ? files : [];
    ctx.usage.decisionCalls++;
    const res = await provider.decide({ model: this.spec.model, state: stateFor(ctx.evidence, provider).slice(0, limit), questions, baseUrl: this.spec.baseUrl, apiKey: this.spec.apiKeyEnv ? ctx.env(this.spec.apiKeyEnv) : undefined, options, images: images.length ? images : undefined, documents: documents.length ? documents : undefined }, ctx);
    parseProvider(this.spec.provider, z.object({ answers: z.record(z.string(), SystemOneAnswerSchema) }), res);
    ctx.usage.inputTokens += res.usage?.inputTokens ?? 0;
    ctx.usage.outputTokens += res.usage?.outputTokens ?? 0;
    return { ...res, ...(attached.length ? { images: { attached: attached.length, sent: images.length } } : {}), ...(files.length ? { documents: { attached: files.length, sent: documents.length } } : {}) };
  }

  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const m = await this.rateMany([ctx]);
    return m.get(ctx.criterion.id) ?? [];
  }

  /** One request, one `state`, one question per criterion. */
  async rateMany(ctxs: JudgeContext[]): Promise<Map<string, Rating[]>> {
    const out = new Map<string, Rating[]>();
    if (!ctxs.length) return out;
    const first = ctxs[0]!;
    const errorAll = (message: string) => { for (const c of ctxs) out.set(c.criterion.id, [{ ...ratingBase(c, this), status: "error", error: message }]); return out; };

    let provider: DecisionProviderAdapter;
    try { provider = getDecisionProvider(this.spec.provider); } catch (e) { return errorAll((e as Error).message); }

    let questions: Record<string, SystemOneQuestion>;
    let limit: number;
    try { questions = this.buildRequest(ctxs); limit = this.stateCharLimit(); }
    catch (error) { return errorAll((error as Error).message); }
    const stateLength = stateFor(first.evidence, provider).length;
    const stateTruncated = stateLength > limit;
    // why: retain the historical diagnostic length, including the truncation marker, without building an unused state copy.
    const stateChars = stateTruncated ? limit + "\n[... state truncated to fit the model context ...]".length : stateLength;
    const started = (first.now ?? Date.now)();
    let res: DecisionResponse;
    try {
      res = await this.ask(first, questions);
    } catch (e) { return errorAll(e instanceof ProviderError ? e.message : `${provider.name}: decide: ${(e as Error).message}`); }
    const latencyMs = (first.now ?? Date.now)() - started;

    for (const c of ctxs) out.set(c.criterion.id, this.answerToRating(c, res, questions[c.criterion.id]!, provider.name, { latencyMs, stateChars, stateTruncated }));

    return out;
  }
  private stateCharLimit(): number {
    const configured = this.spec.options?.stateCharLimit;
    // why: a bad override must not silently erase evidence through slice(0, NaN) or a negative endpoint.
    if (configured !== undefined && (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0)) throw new ProviderError(this.spec.provider, "decide: stateCharLimit must be positive and finite");
    return typeof configured === "number" ? configured : defaultStateCharLimit(this.spec.provider, this.spec.model);
  }

  private buildRequest(ctxs: JudgeContext[]): Record<string, SystemOneQuestion> {
    const questions: Record<string, SystemOneQuestion> = {};
    for (const c of ctxs) questions[c.criterion.id] = buildQuestion(c, criterionLevels(c.rubric, c.criterion, c.scale), this.spec.instructions);

    return questions;
  }

  private answerToRating(c: JudgeContext, res: DecisionResponse, question: SystemOneQuestion, provider: string, timing: { latencyMs: number; stateChars: number; stateTruncated: boolean }): Rating[] {
    const { latencyMs, stateChars, stateTruncated } = timing;
    const base = ratingBase(c, this);
    const answer = res.answers[c.criterion.id];
    if (!answer) { return [{ ...base, status: "error", error: `no answer for question ${c.criterion.id}` }]; }
    try {
      const levels = criterionLevels(c.rubric, c.criterion, c.scale);
      const cut = binaryThreshold(c, answer);
      const { choice, score, normalized, probabilities, confidence } = c.criterion.choices ? answerToChoice(answer, c.criterion, c.scale) : { ...answerToScore(answer, levels, c.scale, cut?.threshold), choice: undefined };
      const low = this.spec.minConfidence !== undefined && confidence < this.spec.minConfidence;
      const dist = Object.entries(probabilities).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(" ");
      const rating: Rating = {
        ...base, status: "scored", choice, score, normalized, confidence, probabilities,
        rationale: `${provider}${res.model ? `/${res.model}` : ""} distribution: ${dist}${low ? ` (low confidence ${confidence.toFixed(2)} < ${this.spec.minConfidence})` : ""}`,
        raw: {
          provider: provider, ...modelFields(res, this.spec.model), question: question, answer, levels, latencyMs, lowConfidence: low, stateChars, stateTruncated,
          ...cut,
          ...(res.images ? { images: res.images } : {}),
          ...(res.documents ? { documents: res.documents } : {}),
        },
      };
      return escalateDecision(c, rating, { spec: this.spec, low, distribution: dist });
    } catch (e) { return [{ ...base, status: "error", error: (e as Error).message, raw: { answer } }]; }
  }



}

/**
 * Records which model was asked for and which one the provider says answered. `model` keeps its old meaning
 * (best known) for stored ratings; `modelVerified` is false when only the requested name — possibly an alias — is known.
 */
function modelFields(res: DecisionResponse, specModel: string | undefined) {
  const requestedModel = res.requestedModel ?? specModel;
  return { model: res.model ?? specModel, requestedModel, resolvedModel: res.resolvedModel, modelVerified: res.resolvedModel !== undefined };
}

/** The P(true) cut for answers mapped onto two labels, and whether the rubric set it; undefined for other answers. */
function binaryThreshold(c: JudgeContext, answer: { noul?: number }) {
  if (c.criterion.choices || (c.scale.type !== "binary" && typeof answer.noul !== "number")) return undefined;
  const set = c.criterion.threshold;
  return { threshold: set ?? DEFAULT_BINARY_THRESHOLD, thresholdSource: set === undefined ? "default" as const : "rubric" as const };
}
