/**
 * Adapts System One-compatible HTTP providers and the deterministic offline fake.
 * Cloudflare wraps results and OpenAI has a request shape of its own; validation precedes all answer mapping.
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
 * OpenAI Decisions — POST /v1/decisions. Shape checked against the live API on 2026-11-11 with gpt-6-luna; it is
 * not the System One shape: the text goes in `input`, questions are an array carrying their own `name`, a score
 * takes `levels` of { label, description }, a choice takes `choices` of { value, description }, and a predicate
 * takes instructions only. Answers come back as an array in the same order. Unknown fields are refused.
 */
const OpenAiAnswerSchema = z.object({
  type: z.string(), name: z.string().nullable().optional(),
  score: z.number().optional(), choice: z.string().optional(), probability: z.number().optional(), confidence: z.number().optional(),
  probabilities: z.array(z.object({ value: z.union([z.number(), z.string()]), probability: z.number() })).optional(),
});
const OpenAiResponseSchema = z.object({
  model: z.string().optional(), answers: z.array(OpenAiAnswerSchema),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});
type OpenAiAnswer = z.infer<typeof OpenAiAnswerSchema>;

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function openaiQuestion(name: string, q: SystemOneQuestion): Record<string, unknown> {
  if (q.type === "choice") return { name, type: "choice", instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => (description ? { value, description } : { value })) };
  if (q.type === "noul") {
    // why: a predicate has no field for what yes and no mean, so the two descriptions ride in the instructions.
    const meaning = [q.criteria?.true ? `Yes means: ${sentence(q.criteria.true)}` : undefined, q.criteria?.false ? `No means: ${sentence(q.criteria.false)}` : undefined].filter(Boolean);
    return { name, type: "predicate", instructions: [q.instructions, ...meaning].join(" ") };
  }
  // why: System One levels are "label: description" strings; answers are matched by position, so the split only decides which field carries the text.
  return { name, type: "score", instructions: q.instructions, levels: q.criteria.map((level) => { const at = level.indexOf(": "); return at > 0 && at + 2 < level.length ? { label: level.slice(0, at), description: level.slice(at + 2) } : { label: level }; }) };
}

function openaiAnswer(a: OpenAiAnswer): SystemOneAnswer {
  if (a.type === "predicate") return { type: "noul", noul: a.probability };
  if (a.type === "choice") return { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: a.probabilities && Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability])) };
  // why: a level's `value` is its index in the request, so sorting by it restores the order the levels were sent in.
  return { type: "score", score: a.score, confidence: a.confidence, probabilities: a.probabilities && [...a.probabilities].sort((x, y) => Number(x.value) - Number(y.value)).map((p) => p.probability) };
}

const openaiDecisionsProvider: DecisionProviderAdapter = {
  name: "openai",
  async decide(req, ctx) {
    const base = (req.baseUrl ?? ctx.env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const key = req.apiKey ?? ctx.env("OPENAI_API_KEY");
    const model = req.model ?? ctx.env("VERDICT_OPENAI_DECISIONS_MODEL") ?? "gpt-6-luna";
    const ids = Object.keys(req.questions);
    const questions = ids.map((id) => openaiQuestion(id, req.questions[id]!));
    const data = await postJson("openai", ctx, `${base}/decisions`, { model, input: req.state, questions, ...requestExtras(req.options) }, key ? { authorization: `Bearer ${key}` } : {});
    const validated = parseProvider("openai", OpenAiResponseSchema, data);
    const answers: Record<string, SystemOneAnswer> = {};
    // why: an answer names its question; one that does not is taken by its place in the array.
    validated.answers.forEach((a, i) => { const id = a.name ?? ids[i]; if (id !== undefined) answers[id] = openaiAnswer(a); });
    const usage = validated.usage;
    return { answers, model: validated.model ?? model, requestedModel: model, resolvedModel: validated.model, usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
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
