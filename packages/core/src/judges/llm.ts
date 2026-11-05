import { z } from "zod";
import type { LlmJudgeSpec as LlmSpec, Scale } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { scaleRange, snapToScale, normalizeScore, median } from "../aggregate/index.js";
import { type Judge, type JudgeContext, ratingBase, renderEvidence } from "./types.js";

type Spec = z.infer<typeof LlmSpec>;

/** What every LLM judge must return. Shared across providers as a JSON schema. */
export const JudgementSchema = z.object({
  choice: z.string().optional(),
  score: z.number().default(0).describe("The score on the criterion's scale, exactly as instructed"),
  confidence: z.number().min(0).max(1).describe("How confident you are in this score, 0..1"),
  rationale: z.string().describe("2-5 sentences explaining the score against the anchors"),
  quotes: z.array(z.string()).describe("Short verbatim quotes from the inputs that support the score (max 5)"),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const JUDGEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "confidence", "rationale", "quotes"],
  properties: {
    score: { type: "number" },
    choice: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
    quotes: { type: "array", items: { type: "string" } },
  },
} as const;

export interface LlmRequest {
  system: string;
  user: string;
  model?: string;
  effort?: Spec["effort"];
  maxTokens: number;
  options?: Record<string, unknown>;
  baseUrl?: string;
  apiKey?: string;
}
export interface LlmResponse {
  judgement: Judgement;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
  model?: string;
}

/** Any "Decision AI" can be plugged in by implementing this. */
export interface LlmProviderAdapter {
  name: string;
  complete(req: LlmRequest, ctx: JudgeContext): Promise<LlmResponse>;
}

const providers = new Map<string, LlmProviderAdapter>();
export function registerLlmProvider(p: LlmProviderAdapter) { providers.set(p.name, p); }
export function getLlmProvider(name: string): LlmProviderAdapter {
  const p = providers.get(name);
  if (!p) throw new Error(`unknown LLM provider "${name}" (registered: ${[...providers.keys()].join(", ")})`);
  return p;
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

export function describeScale(scale: Scale): string {
  switch (scale.type) {
    case "numeric": return `an integer or decimal between ${scale.min} and ${scale.max}${scale.step ? ` in steps of ${scale.step}` : ""} (${scale.min} = worst, ${scale.max} = best)`;
    case "binary": return `0 or 1 (0 = ${scale.labels?.[0] ?? "fail"}, 1 = ${scale.labels?.[1] ?? "pass"})`;
    case "ordinal": {
      const vals = scale.values ?? scale.labels.map((_, i) => i);
      return `one of: ${scale.labels.map((l, i) => `${vals[i]} = "${l}"`).join(", ")} (ordered worst to best)`;
    }
  }
}

export function buildSystemPrompt(ctx: JudgeContext, extra?: string): string {
  const { rubric, criterion, scale } = ctx;
  const anchors = criterion.anchors
    ? Object.entries(criterion.anchors).map(([k, v]) => `  - ${k}: ${v}`).join("\n")
    : undefined;
  const lang = rubric.language ? `Write the rationale in language "${rubric.language}".` : "Write the rationale in the same language as the inputs.";
  return [
    `You are a rigorous, impartial evaluator. You score ONE criterion of a rubric based strictly on the provided inputs.`,
    ``,
    `# Rubric: ${rubric.name}${rubric.version ? ` (v${rubric.version})` : ""}`,
    rubric.description ? rubric.description : undefined,
    rubric.context ? `\n## Evaluation context\n${rubric.context}` : undefined,
    ``,
    `# Criterion: ${criterion.name} (id: ${criterion.id})`,
    criterion.description ?? "",
    ``,
    `## Scale`,
    criterion.choices ? `Return the chosen option id in choice. Options: ${JSON.stringify(criterion.choices)}. Set score to 0; Verdict maps the choice to its value.` : `Score must be ${describeScale(scale)}.`,
    anchors ? `\n## Anchors (what each level looks like)\n${anchors}` : undefined,
    ``,
    `## Rules`,
    `- Judge only this criterion. Ignore qualities covered by other criteria.`,
    `- Base the score on evidence in the inputs. Do not reward claims without support; do not penalize for missing information that the criterion does not require.`,
    `- If the inputs do not contain enough information to assess the criterion, give the lowest reasonable score and say so in the rationale with low confidence.`,
    `- Quote verbatim passages that drove the score.`,
    `- ${lang}`,
    extra ? `\n## Additional instructions\n${extra}` : undefined,
  ].filter((l) => l !== undefined).join("\n");
}

/* ------------------------------------------------------------------ */
/* The judge                                                           */
/* ------------------------------------------------------------------ */

export class LlmJudge implements Judge {
  readonly type = "llm" as const;
  readonly id: string;
  constructor(public spec: Spec) { this.id = spec.id ?? `llm:${spec.provider}${spec.model ? `/${spec.model}` : ""}`; }
  expectedRatings() { return 1; }

  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const base = ratingBase(ctx, this);
    const started = Date.now();
    let provider: LlmProviderAdapter;
    try { provider = getLlmProvider(this.spec.provider); } catch (e) { return [{ ...base, status: "error", error: (e as Error).message }]; }
    const req: LlmRequest = {
      system: buildSystemPrompt(ctx, this.spec.instructions),
      user: `Evaluate the following inputs for the criterion "${ctx.criterion.name}".\n\n${renderEvidence(ctx.evidence)}`,
      model: this.spec.model,
      effort: this.spec.effort,
      maxTokens: 4000,
      options: this.spec.options,
      baseUrl: this.spec.baseUrl,
      apiKey: this.spec.apiKeyEnv ? ctx.env(this.spec.apiKeyEnv) : undefined,
    };
    try {
      const samples = await Promise.all(Array.from({ length: this.spec.samples }, () => provider.complete(req, ctx)));
      for (const s of samples) {
        ctx.usage.llmCalls++;
        ctx.usage.inputTokens += s.usage?.inputTokens ?? 0;
        ctx.usage.outputTokens += s.usage?.outputTokens ?? 0;
      }
      if (ctx.criterion.choices) {
        const options = Object.keys(ctx.criterion.choices);
        for (const s of samples) if (!s.judgement.choice || !Object.hasOwn(ctx.criterion.choices, s.judgement.choice)) throw new Error("invalid LLM choice");
        const counts = options.map(o => samples.filter(s => s.judgement.choice === o).length);
        const choice = options[counts.indexOf(Math.max(...counts))]!;
        const best = samples.find(s => s.judgement.choice === choice)!;
        const score = ctx.criterion.values?.[choice];
        return [{ ...base, status: "scored", choice, score, normalized: score === undefined ? undefined : normalizeScore(score, ctx.scale), confidence: best.judgement.confidence, rationale: best.judgement.rationale, quotes: best.judgement.quotes, probabilities: Object.fromEntries(options.map((o, i) => [o, counts[i]! / samples.length])) }];
      }
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
        quotes: best.judgement.quotes.slice(0, 5),
        raw: { provider: provider.name, model: best.model ?? this.spec.model, samples: scores, agreement, latencyMs: Date.now() - started },
      }];
    } catch (e) {
      return [{ ...base, status: "error", error: (e as Error).message, raw: { provider: provider.name, latencyMs: Date.now() - started } }];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

function parseJudgement(text: string): Judgement {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JudgementSchema.parse(JSON.parse(body));
}

/** Anthropic (Claude) — default provider. Uses structured outputs + server-side refusal fallbacks. */
export const anthropicProvider: LlmProviderAdapter = {
  name: "anthropic",
  async complete(req, ctx) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const client = new Anthropic({ apiKey: req.apiKey ?? ctx.env("ANTHROPIC_API_KEY"), baseURL: req.baseUrl, fetch: ctx.fetch });
    const model = req.model ?? ctx.env("VERDICT_ANTHROPIC_MODEL") ?? "claude-opus-5-5";
    const message = await client.beta.messages.parse(
      {
        model,
        max_tokens: req.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: req.effort ?? "medium", format: zodOutputFormat(JudgementSchema) },
        ...(req.options ?? {}),
      },
      { signal: ctx.signal },
    );
    if (message.stop_reason === "refusal") throw new Error(`model declined to evaluate (${message.stop_details?.category ?? "refusal"})`);
    const judgement = message.parsed_output ?? parseJudgement(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    return {
      judgement,
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens },
      raw: { id: message.id, stop_reason: message.stop_reason },
    };
  },
};

/** Any OpenAI-compatible chat completions endpoint (OpenAI, Groq, Together, vLLM, Ollama, ...). */
export const openaiCompatibleProvider: LlmProviderAdapter = {
  name: "openai",
  async complete(req, ctx) {
    const base = (req.baseUrl ?? ctx.env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const key = req.apiKey ?? ctx.env("OPENAI_API_KEY");
    const res = await ctx.fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: req.model ?? ctx.env("OPENAI_MODEL") ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: req.system + "\n\nRespond with a single JSON object with keys: score, confidence, rationale, quotes." },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: "judgement", strict: true, schema: JUDGEMENT_JSON_SCHEMA } },
        max_tokens: req.maxTokens,
        ...(req.options ?? {}),
      }),
    });
    if (!res.ok) throw new Error(`openai-compatible provider -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { model?: string; choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { judgement: parseJudgement(data.choices[0]!.message.content), model: data.model, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 }, raw: data };
  },
};

/** Cloudflare Workers AI (REST). Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, or pass `baseUrl` for an AI Gateway. */
export const cloudflareProvider: LlmProviderAdapter = {
  name: "cloudflare",
  async complete(req, ctx) {
    const account = ctx.env("CLOUDFLARE_ACCOUNT_ID");
    const token = req.apiKey ?? ctx.env("CLOUDFLARE_API_TOKEN");
    const model = req.model ?? ctx.env("CLOUDFLARE_AI_MODEL") ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const base = req.baseUrl ?? (account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run` : undefined);
    if (!base) throw new Error("cloudflare provider needs CLOUDFLARE_ACCOUNT_ID (or judge.baseUrl)");
    const res = await ctx.fetch(`${base}/${model}`, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        messages: [
          { role: "system", content: req.system + "\n\nRespond with a single JSON object with keys: score, confidence, rationale, quotes." },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: JUDGEMENT_JSON_SCHEMA },
        max_tokens: req.maxTokens,
        ...(req.options ?? {}),
      }),
    });
    if (!res.ok) throw new Error(`cloudflare provider -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { result?: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } }; success?: boolean; errors?: unknown };
    if (data.success === false) throw new Error(`cloudflare provider error: ${JSON.stringify(data.errors)}`);
    const r = data.result?.response;
    const judgement = typeof r === "string" ? parseJudgement(r) : JudgementSchema.parse(r);
    return { judgement, model, usage: { inputTokens: data.result?.usage?.prompt_tokens ?? 0, outputTokens: data.result?.usage?.completion_tokens ?? 0 }, raw: data };
  },
};

/**
 * Generic HTTP decision endpoint. POST {system, user, criterion, scale, evidence, schema} -> {score, confidence?, rationale?, quotes?}.
 * Use this to plug in any proprietary decision model behind your own service.
 */
export const httpProvider: LlmProviderAdapter = {
  name: "http",
  async complete(req, ctx) {
    const url = req.baseUrl ?? ctx.env("VERDICT_HTTP_JUDGE_URL");
    if (!url) throw new Error("http provider needs judge.baseUrl (or VERDICT_HTTP_JUDGE_URL)");
    const key = req.apiKey ?? ctx.env("VERDICT_HTTP_JUDGE_KEY");
    const res = await ctx.fetch(url, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ system: req.system, user: req.user, model: req.model, criterion: ctx.criterion, scale: ctx.scale, evidence: ctx.evidence, schema: JUDGEMENT_JSON_SCHEMA, options: req.options }),
    });
    if (!res.ok) throw new Error(`http judge -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as Partial<Judgement> & { usage?: { inputTokens?: number; outputTokens?: number }; model?: string };
    const judgement = JudgementSchema.parse({ choice: data.choice, score: data.score, confidence: data.confidence ?? 0.5, rationale: data.rationale ?? "", quotes: data.quotes ?? [] });
    return { judgement, model: data.model, usage: { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 }, raw: data };
  },
};

/** Deterministic fake for tests and dry runs. options.score (raw) or options.normalized, else keyword heuristic. */
export const mockProvider: LlmProviderAdapter = {
  name: "mock",
  async complete(req, ctx) {
    const [lo, hi] = scaleRange(ctx.scale);
    const o = req.options ?? {};
    let score: number;
    if (typeof o.score === "number") score = o.score;
    else if (typeof o.normalized === "number") score = lo + (hi - lo) * o.normalized;
    else {
      // crude heuristic: longer evidence that mentions the criterion name scores higher
      const text = ctx.evidence.map((e) => e.text).join(" ").toLowerCase();
      const mention = text.includes(ctx.criterion.name.toLowerCase()) ? 0.3 : 0;
      const len = Math.min(1, text.length / 2000) * 0.5;
      score = lo + (hi - lo) * (0.2 + mention + len);
    }
    return { judgement: { choice: ctx.criterion.choices ? String(o.choice ?? Object.keys(ctx.criterion.choices)[0]) : undefined, score, confidence: 0.5, rationale: `mock judgement for ${ctx.criterion.id}`, quotes: [] }, model: "mock", usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: 50 } };
  },
};

for (const p of [anthropicProvider, openaiCompatibleProvider, cloudflareProvider, httpProvider, mockProvider]) registerLlmProvider(p);
