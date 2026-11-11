/**
 * Adapts System One-compatible HTTP providers and the deterministic offline fake.
 * Cloudflare wraps results and OpenAI renames predicates; validation precedes all answer mapping.
 */
import { z } from "zod";
import { canonicalJson } from "../../idempotency.js";
import { parseProvider, ProviderError, readProviderJson, fetchProvider, SystemOneResponseSchema } from "../../provider-error.js";
import type { JudgeContext } from "../types.js";
import { CLEF_LIMITS, clefImages } from "./images.js";
import { registerDecisionProvider, type DecisionProviderAdapter, type DecisionRequest, type SystemOneAnswer, type SystemOneQuestion } from "./contracts.js";

/**
 * Judge `options` are Verdict-level knobs (stateCharLimit, accountId, selector, mock knobs such as level/noul/choice).
 * Only `options.request` is merged verbatim into the provider request body (e.g. Clef `images`).
 */
function requestExtras(options?: Record<string, unknown>): Record<string, unknown> {
  const extra = options?.request;
  return extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
}

async function postJson(provider: string, ctx: JudgeContext, url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetchProvider(provider, ctx.fetch, url, { method: "POST", signal: ctx.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return parseProvider(provider, z.record(z.string(), z.unknown()), await readProviderJson(provider, res));
}

function systemOneAdapter(name: string, defaults: { baseUrl?: string; keyEnv: string; model: string; path?: string }): DecisionProviderAdapter {
  return {
    name,
    async decide(req, ctx) {
      const base = (req.baseUrl ?? ctx.env(`${name.toUpperCase()}_BASE_URL`) ?? defaults.baseUrl)?.replace(/\/$/, "");
      if (!base) throw new ProviderError(name, "provider needs judge.baseUrl");
      const key = req.apiKey ?? ctx.env(defaults.keyEnv);
      const model = req.model ?? ctx.env(`VERDICT_${name.toUpperCase()}_MODEL`) ?? defaults.model;
      // why: judge options stay local; only options.request may override the provider wire body.
      const data = await postJson(name, ctx, `${base}${defaults.path ?? "/systemone"}`, { model, state: req.state, questions: req.questions, ...requestExtras(req.options) }, key ? { authorization: `Bearer ${key}` } : {});
      const d = parseProvider(name, SystemOneResponseSchema, data);
      const usage = d.usage;
      return { answers: d.answers ?? {}, model: d.model ?? model, requestedModel: model, resolvedModel: d.model, usage: { inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
    },
  };
}

/** TypeSafe Jev — POST https://api.typesafe.ai/v1/systemone */
const typesafeProvider = systemOneAdapter("typesafe", { baseUrl: "https://api.typesafe.ai/v1", keyEnv: "TYPESAFE_API_KEY", model: "jev-latest" });

/** Any endpoint that speaks the System One request shape (self-hosted Clef, DigitalOcean Inference, gateways). */
const systemOneProvider = systemOneAdapter("systemone", { keyEnv: "SYSTEMONE_API_KEY", model: "jev-latest" });

/** OpenRouter decisions endpoint (model ids like typesafe/jev-1.13, inception/mercury-decide). */
const openrouterProvider = systemOneAdapter("openrouter", { baseUrl: "https://openrouter.ai/api/alpha", keyEnv: "OPENROUTER_API_KEY", model: "typesafe/jev-1.13", path: "/decisions" });

/**
 * Cloudflare Workers AI — Clef / Clef-flash (System One-compatible body + Clef extensions).
 * Per the model pages: body needs `model: "clef" | "clef-flash"` (selector, not the @cf id), `state`, `questions`
 * (1–64, ids [A-Za-z0-9_.-]{1,100}); optional `images` (≤4 embedded PNG/JPEG/WebP). REST wraps the answer in `result`.
 * Context: clef 65,536 tokens ($0.24/M input), clef-flash 24,576 tokens ($0.038/M input); output tokens are free.
 */
const cloudflareDecisionProvider: DecisionProviderAdapter = {
  name: "cloudflare",
  acceptsImages: true,
  maxImages: CLEF_LIMITS.maxImages,
  async decide(req, ctx) {
    const options = parseProvider("cloudflare", z.object({ accountId: z.string().optional(), selector: z.string().optional() }), req.options ?? {});
    const account = options.accountId ?? ctx.env("CLOUDFLARE_ACCOUNT_ID");
    const token = req.apiKey ?? ctx.env("CLOUDFLARE_API_TOKEN");
    const model = req.model ?? ctx.env("VERDICT_CLOUDFLARE_MODEL") ?? "@cf/cloudflare/clef-flash";
    const base = req.baseUrl?.replace(/\/$/, "") ?? (account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run` : undefined);
    if (!base) throw new ProviderError("cloudflare", "cloudflare provider needs CLOUDFLARE_ACCOUNT_ID (or judge.baseUrl pointing at an AI Gateway)");
    if (!token) throw new ProviderError("cloudflare", "cloudflare provider needs CLOUDFLARE_API_TOKEN (Workers AI: Read)");
    // why: Cloudflare routes by the full model id but its System One body expects the short selector.
    const selector = options.selector;
    const extras = requestExtras(req.options);
    const images = clefImages(extras, req.images);
    const body = { model: selector ?? model.split("/").pop(), state: req.state, questions: req.questions, ...extras, ...(images.length ? { images } : {}) };
    const data = await postJson("cloudflare", ctx, `${base}/${model}`, body, { authorization: `Bearer ${token}` });
    if (data.success === false) throw new ProviderError("cloudflare", `cloudflare error: ${JSON.stringify(data.errors)}`);
    const d = parseProvider("cloudflare", SystemOneResponseSchema, data.result ?? data);
    const usage = d.usage;
    // why: `model` stays the routed @cf id as before; the body's (often short) model name is recorded as resolved only.
    return { answers: d.answers ?? {}, model, requestedModel: model, resolvedModel: d.model, usage: { inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
  },
};

/**
 * OpenAI Decisions API — POST /v1/decisions (public beta, gpt-6-luna). Question types: predicate | choice | score.
 * Field names follow public write-ups and are parsed defensively; pin `baseUrl`/`options` if the beta shape differs.
 */
const openaiDecisionsProvider: DecisionProviderAdapter = {
  name: "openai",
  async decide(req, ctx) {
    const base = (req.baseUrl ?? ctx.env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const key = req.apiKey ?? ctx.env("OPENAI_API_KEY");
    const model = req.model ?? ctx.env("VERDICT_OPENAI_DECISIONS_MODEL") ?? "gpt-6-luna";
    // why: OpenAI calls binary questions predicates; normalize back to noul after validating the envelope.
    const questions = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, q.type === "noul" ? { type: "predicate", instructions: q.instructions, criteria: q.criteria } : q]));
    const data = await postJson("openai", ctx, `${base}/decisions`, { model, state: req.state, questions, ...requestExtras(req.options) }, key ? { authorization: `Bearer ${key}` } : {});
    const validated = parseProvider("openai", SystemOneResponseSchema, data);
    const answers: Record<string, SystemOneAnswer> = {};
    for (const [id, a] of Object.entries(validated.answers ?? validated.decisions ?? {})) {
      answers[id] = { ...a, noul: a.noul ?? a.predicate ?? a.probability };
    }
    const usage = validated.usage;
    return { answers, model: validated.model ?? model, requestedModel: model, resolvedModel: validated.model, usage: { inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
  },
};

/**
 * Answers recorded by an earlier run, replayed for re-scoring under another policy (`rescoreRunUnder`). A question
 * that differs from the one recorded was never asked of the model, so it is refused rather than answered.
 */
export interface ReplayOptions { answers: Record<string, SystemOneAnswer>; questions: Record<string, SystemOneQuestion> }

function replayDecision(req: DecisionRequest, replay: ReplayOptions) {
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const asked = replay.questions[id], answer = replay.answers[id];
    if (!asked || !answer) throw new ProviderError("mock", `replay: no recorded answer for question ${id}`);
    if (canonicalJson(asked) !== canonicalJson(q)) throw new ProviderError("mock", `replay: question ${id} differs from the one recorded`);
    answers[id] = answer;
  }
  return { answers, model: "replay", usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * Deterministic fake. options.level (index) / options.normalized / options.probabilities / options.noul, else a length
 * heuristic; options.replay returns recorded answers instead (see ReplayOptions).
 */
const mockDecisionProvider: DecisionProviderAdapter = {
  name: "mock",
  acceptsImages: true,
  async decide(req) {
    if (req.options?.replay) return replayDecision(req, req.options.replay as ReplayOptions);
    const answers: Record<string, SystemOneAnswer> = {};
    const o = req.options ?? {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = mockAnswer(req, q, o);
    return { answers, model: "mock-decision", requestedModel: req.model, resolvedModel: "mock-decision", usage: { inputTokens: Math.ceil(req.state.length / 4) + 50 * Object.keys(req.questions).length, outputTokens: 0 }, raw: { images: req.images?.length ?? 0 } };
  },
};

let builtInsRegistered = false;

/**
 * Registers the built-in adapters once. Called by `decision.ts` rather than run on import: packages are marked
 * `"sideEffects": false`, so bundlers (esbuild in `wrangler`) drop side-effect-only imports and Workers would start
 * with no providers at all. Later registrations of the same name (e.g. the Workers AI binding) still win.
 */
export function registerBuiltInDecisionProviders(): void {
  if (builtInsRegistered) return;
  builtInsRegistered = true;
  // Give configuration, transport and mapping failures a consistent provider/operation boundary.
  for (const provider of [typesafeProvider, systemOneProvider, openrouterProvider, cloudflareDecisionProvider, openaiDecisionsProvider, mockDecisionProvider]) {
    registerDecisionProvider({
      // The wrapper only adds error context; it must keep what the adapter can accept.
      name: provider.name, acceptsImages: provider.acceptsImages, maxImages: provider.maxImages,
      async decide(request, context) {
        try { return await provider.decide(request, context); }
        catch (cause) {
          const status = cause instanceof ProviderError ? cause.status : undefined;
          const detail = cause instanceof ProviderError ? cause.message.slice(cause.provider.length + 2) : cause instanceof Error ? cause.message : String(cause);
          throw new ProviderError(provider.name, `decide: ${detail}`, status, { cause });
        }
      },
    });
  }
}

function mockAnswer(req: DecisionRequest, q: SystemOneQuestion, o: Record<string, unknown>): SystemOneAnswer {
  if (q.type === "choice") return mockChoice(req, q, o);
  if (q.type === "noul") return mockNoul(req, o);
  return mockScore(req, q, o);
}
function mockChoice(req: DecisionRequest, q: Extract<SystemOneQuestion, { type: "choice" }>, o: Record<string, unknown>): SystemOneAnswer {
  const words = new Set(req.state.toLowerCase().match(/\w+/g) ?? []);
  const options = Object.keys(q.criteria);
  const hits = options.map(o => (q.criteria[o] ?? "").toLowerCase().match(/\w+/g)?.filter(w => words.has(w)).length ?? 0);
  const choice = typeof o.choice === "string" ? o.choice : options[hits.indexOf(Math.max(...hits))]!;
  return { type: "choice", choice, probabilities: Object.fromEntries(options.map(k => [k, k === choice ? 1 : 0])), confidence: 1 };

}
function mockNoul(req: DecisionRequest, o: Record<string, unknown>): SystemOneAnswer {
  const p = typeof o.noul === "number" ? o.noul : typeof o.normalized === "number" ? o.normalized : /\b(lorem ipsum|test message|spam)\b/i.test(req.state) ? 0.1 : /\b(yes|pass|present)\b/i.test(req.state) ? 0.9 : 0.75;
  return { type: "noul", noul: p };

}
function mockScore(req: DecisionRequest, q: Extract<SystemOneQuestion, { type: "score" }>, o: Record<string, unknown>): SystemOneAnswer {
  const n = q.criteria.length;
  let probs: number[];
  if (Array.isArray(o.probabilities) && o.probabilities.length === n) probs = o.probabilities as number[];
  else {
    const target = typeof o.level === "number" ? o.level : typeof o.normalized === "number" ? o.normalized * (n - 1) : Math.min(n - 1, (req.state.length / 400) % n);
    probs = Array.from({ length: n }, (_, i) => Math.exp(-((i - target) ** 2) / 0.5));
    const sum = probs.reduce((a, b) => a + b, 0);
    probs = probs.map((p) => p / sum);
  }
  const score = probs.reduce((s, p, i) => s + p * i, 0);
  return { type: "score", score, probabilities: probs, confidence: (Math.max(...probs) - 1 / n) / (1 - 1 / n), legend: q.criteria };
}
