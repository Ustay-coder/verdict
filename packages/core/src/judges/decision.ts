import { z } from "zod";
import type { Criterion, DecisionJudgeSpec as DecisionSpecSchema, Rubric, Scale } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { normalizeScore, scaleRange, snapToScale } from "../aggregate/index.js";
import { type Judge, type JudgeContext, newRatingId, ratingBase, renderEvidence } from "./types.js";
import { evidenceImages } from "../ingest/index.js";

type Spec = z.infer<typeof DecisionSpecSchema>;

/* ------------------------------------------------------------------ */
/* Rubric levels: the bridge between a criterion scale and a decision  */
/* model's ordered `score` rubric (2–10 levels, worst → best).         */
/* ------------------------------------------------------------------ */

export interface Level { value: number; label: string; description: string }

export function criterionLevels(rubric: Rubric, c: Criterion, scale: Scale = c.scale ?? rubric.scale): Level[] {
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
  // numeric: anchors keyed by number become levels; otherwise evenly spaced generic levels.
  const anchored = Object.entries(c.anchors ?? {})
    .map(([k, d]) => ({ value: Number(k), label: k, description: d }))
    .filter((l) => Number.isFinite(l.value))
    .sort((a, b) => a.value - b.value);
  if (anchored.length >= 2) return anchored.slice(0, 10);
  const [lo, hi] = scaleRange(scale);
  const n = scale.step ? Math.min(10, Math.max(2, Math.round((hi - lo) / scale.step) + 1)) : Math.min(10, Math.max(2, Math.round(hi - lo) + 1));
  const words = ["very poor", "poor", "below average", "average", "above average", "good", "very good", "excellent", "outstanding", "perfect"];
  return Array.from({ length: n }, (_, i) => {
    const value = n === 1 ? lo : lo + ((hi - lo) * i) / (n - 1);
    const w = words[Math.round((i / (n - 1)) * (words.length - 1))]!;
    return { value: Number(value.toFixed(3)), label: String(Number(value.toFixed(3))), description: `${c.name} is ${w}${c.description ? ` (${c.description})` : ""}` };
  });
}

/* ------------------------------------------------------------------ */
/* System One question / answer shapes (TypeSafe Jev; Clef-compatible)  */
/* ------------------------------------------------------------------ */

export type SystemOneQuestion =
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export interface SystemOneAnswer {
  type?: string;
  score?: number;
  legend?: string[] | Record<string, string>;
  probabilities?: number[] | Record<string, number>;
  confidence?: number;
  noul?: number;
  choice?: string;
}

export interface DecisionRequest {
  model?: string;
  state: string;
  questions: Record<string, SystemOneQuestion>;
  baseUrl?: string;
  apiKey?: string;
  options?: Record<string, unknown>;
  /** Embedded images (data URIs) from the evidence; only sent to adapters with `acceptsImages`. */
  images?: string[];
}
export interface DecisionResponse {
  answers: Record<string, SystemOneAnswer>;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
  /** Images in the evidence vs. images actually sent (text-only providers drop them; Clef takes at most 4). */
  images?: { attached: number; sent: number };
}

export interface DecisionProviderAdapter {
  name: string;
  /** Vision-capable: the request may carry `images`. Text-only adapters never receive them. */
  acceptsImages?: boolean;
  /** Most images one request may carry (extra images are dropped and reported). */
  maxImages?: number;
  decide(req: DecisionRequest, ctx: JudgeContext): Promise<DecisionResponse>;
}

const providers = new Map<string, DecisionProviderAdapter>();
export function registerDecisionProvider(p: DecisionProviderAdapter) { providers.set(p.name, p); }
export function getDecisionProvider(name: string): DecisionProviderAdapter {
  const p = providers.get(name);
  if (!p) throw new Error(`unknown decision provider "${name}" (registered: ${[...providers.keys()].join(", ")})`);
  return p;
}

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

/** Turn a System One answer into a raw score on the criterion scale + per-level probabilities. */
export function answerToScore(answer: SystemOneAnswer, levels: Level[], scale: Scale): { score: number; normalized: number; probabilities: Record<string, number>; confidence: number } {
  if (scale.type === "binary" || typeof answer.noul === "number") {
    const p = typeof answer.noul === "number" ? answer.noul : answer.score !== undefined ? answer.score / Math.max(1, levels.length - 1) : 0;
    const [no, yes] = levels.length >= 2 ? levels : [{ label: "no" }, { label: "yes" }];
    return { score: p >= 0.5 ? 1 : 0, normalized: normalizeScore(p >= 0.5 ? 1 : 0, scale), probabilities: { [no!.label]: r4(1 - p), [yes!.label]: r4(p) }, confidence: r4(Math.abs(2 * p - 1)) };
  }
  const probs = toProbArray(answer.probabilities, levels.length);
  let expected: number;
  if (probs) expected = probs.reduce((s, p, i) => s + p * (levels[i]?.value ?? i), 0) / Math.max(1e-9, probs.reduce((s, p) => s + p, 0));
  else if (typeof answer.score === "number") {
    // probability-weighted level index, possibly fractional → interpolate between level values
    const idx = Math.min(Math.max(answer.score, 0), levels.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    expected = levels[lo]!.value + (levels[hi]!.value - levels[lo]!.value) * (idx - lo);
  } else throw new Error("decision answer has neither probabilities nor score");
  const score = snapToScale(expected, scale);
  const probabilities = Object.fromEntries(levels.map((l, i) => [l.label, r4(probs ? probs[i]! : i === Math.round(answer.score ?? 0) ? 1 : 0)]));
  return { score, normalized: normalizeScore(expected, scale), probabilities, confidence: answer.confidence ?? (probs ? concentration(probs) : 0.5) };
}

export function answerToChoice(answer: SystemOneAnswer, c: Criterion, scale: Scale) {
  const choice = answer.choice;
  if (!choice || !Object.hasOwn(c.choices!, choice)) throw new Error("invalid decision choice");
  const probabilities = Object.fromEntries(Object.keys(c.choices!).map(o => [o, answer.probabilities && !Array.isArray(answer.probabilities) ? answer.probabilities[o] ?? 0 : o === choice ? 1 : 0]));
  const score = c.values?.[choice];
  return { choice, score, normalized: score === undefined ? undefined : normalizeScore(score, scale), probabilities, confidence: answer.confidence ?? concentration(Object.values(probabilities)) };
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

function toProbArray(p: SystemOneAnswer["probabilities"], n: number): number[] | undefined {
  if (!p) return undefined;
  if (Array.isArray(p)) return p.length === n ? p : undefined;
  const vals = Object.values(p);
  return vals.length === n ? vals : undefined;
}
/** Choice-style confidence: (p_max - 1/n) / (1 - 1/n). */
function concentration(p: number[]) { const n = p.length; if (n < 2) return 1; return (Math.max(...p) - 1 / n) / (1 - 1 / n); }

/* ------------------------------------------------------------------ */
/* The judge                                                           */
/* ------------------------------------------------------------------ */

/**
 * Conservative state budgets (chars ≈ tokens × 4) so a request never exceeds the model's context window:
 * Jev: 64k/request, 32k for state + longest question. Clef: 65,536. Clef-flash: 24,576. Room is left for questions.
 */
export function defaultStateCharLimit(provider: string, model?: string): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("clef-flash")) return 18_000 * 4;
  if (provider === "cloudflare") return 50_000 * 4;
  return 28_000 * 4; // Jev and System One-compatible hosts
}

export class DecisionJudge implements Judge {
  readonly type = "decision" as const;
  readonly id: string;
  constructor(public spec: Spec) { this.id = spec.id ?? `decision:${spec.provider}${spec.model ? `/${spec.model}` : ""}`; }
  expectedRatings() { return 1; }
  /** Only judges with an identical spec share a request (model, thresholds, options, ...). */
  batchKey() { return `decision|${JSON.stringify(this.spec)}`; }

  async ask(ctx: JudgeContext, questions: Record<string, SystemOneQuestion>): Promise<DecisionResponse> {
    const provider = getDecisionProvider(this.spec.provider);
    const limit = typeof this.spec.options?.stateCharLimit === "number" ? this.spec.options.stateCharLimit : defaultStateCharLimit(this.spec.provider, this.spec.model);
    const { stateCharLimit: _limit, ...options } = this.spec.options ?? {};
    const attached = ctx.evidence.flatMap(evidenceImages);
    const images = provider.acceptsImages ? attached.slice(0, provider.maxImages ?? attached.length) : [];
    ctx.usage.decisionCalls++;
    const res = await provider.decide({ model: this.spec.model, state: renderEvidence(ctx.evidence).slice(0, limit), questions, baseUrl: this.spec.baseUrl, apiKey: this.spec.apiKeyEnv ? ctx.env(this.spec.apiKeyEnv) : undefined, options, images: images.length ? images : undefined }, ctx);
    ctx.usage.inputTokens += res.usage?.inputTokens ?? 0;
    ctx.usage.outputTokens += res.usage?.outputTokens ?? 0;
    return attached.length ? { ...res, images: { attached: attached.length, sent: images.length } } : res;
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

    const levelsBy = new Map(ctxs.map((c) => [c.criterion.id, criterionLevels(c.rubric, c.criterion, c.scale)]));
    const questions: Record<string, SystemOneQuestion> = {};
    for (const c of ctxs) questions[c.criterion.id] = buildQuestion(c, levelsBy.get(c.criterion.id)!, this.spec.instructions);

    const limit = typeof this.spec.options?.stateCharLimit === "number" ? (this.spec.options.stateCharLimit as number) : defaultStateCharLimit(this.spec.provider, this.spec.model);
    let state = renderEvidence(first.evidence);
    const stateTruncated = state.length > limit;
    if (stateTruncated) state = `${state.slice(0, limit)}\n[... state truncated to fit the model context ...]`;
    const started = Date.now();
    let res: DecisionResponse;
    try {
      res = await this.ask(first, questions);
    } catch (e) { return errorAll(`${provider.name}: ${(e as Error).message}`); }
    const latencyMs = Date.now() - started;

    for (const c of ctxs) {
      const base = ratingBase(c, this);
      const answer = res.answers[c.criterion.id];
      if (!answer) { out.set(c.criterion.id, [{ ...base, status: "error", error: `no answer for question ${c.criterion.id}` }]); continue; }
      try {
        const levels = levelsBy.get(c.criterion.id)!;
        const { choice, score, normalized, probabilities, confidence } = c.criterion.choices ? answerToChoice(answer, c.criterion, c.scale) : { ...answerToScore(answer, levels, c.scale), choice: undefined };
        const low = this.spec.minConfidence !== undefined && confidence < this.spec.minConfidence;
        const dist = Object.entries(probabilities).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(" ");
        const rating: Rating = {
          ...base, status: "scored", choice, score, normalized, confidence, probabilities,
          rationale: `${provider.name}${res.model ? `/${res.model}` : ""} distribution: ${dist}${low ? ` (low confidence ${confidence.toFixed(2)} < ${this.spec.minConfidence})` : ""}`,
          raw: { provider: provider.name, model: res.model ?? this.spec.model, question: questions[c.criterion.id], answer, levels, latencyMs, lowConfidence: low, stateChars: state.length, stateTruncated, ...(res.images ? { images: res.images } : {}) },
        };
        if (low && this.spec.onLowConfidence === "error") out.set(c.criterion.id, [{ ...rating, status: "error", error: `confidence ${confidence.toFixed(2)} below ${this.spec.minConfidence}` }]);
        else if (low && this.spec.onLowConfidence === "human") {
          // Hand the criterion to a person; keep the model's answer in `raw` for context.
          out.set(c.criterion.id, [{ id: newRatingId(), criterionId: c.criterion.id, raterId: this.spec.escalateTo[0] && this.spec.escalateTo.length === 1 ? this.spec.escalateTo[0] : `human#1`, judgeType: "human", status: "pending", createdAt: new Date().toISOString(), raw: { instructions: `Decision model was unsure (confidence ${confidence.toFixed(2)}): ${dist}. Please score "${c.criterion.name}".`, allowedRaters: this.spec.escalateTo, escalatedFrom: rating } }]);
        } else out.set(c.criterion.id, [rating]);
      } catch (e) { out.set(c.criterion.id, [{ ...base, status: "error", error: (e as Error).message, raw: { answer } }]); }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Judge `options` are Verdict-level knobs (stateCharLimit, accountId, selector, mock knobs such as level/noul/choice).
 * Only `options.request` is merged verbatim into the provider request body (e.g. Clef `images`).
 */
function requestExtras(options?: Record<string, unknown>): Record<string, unknown> {
  const extra = options?.request;
  return extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
}

async function postJson(ctx: JudgeContext, url: string, body: unknown, headers: Record<string, string>) {
  const res = await ctx.fetch(url, { method: "POST", signal: ctx.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function systemOneAdapter(name: string, defaults: { baseUrl?: string; keyEnv: string; model: string; path?: string; unwrap?: (d: Record<string, unknown>) => Record<string, unknown> }): DecisionProviderAdapter {
  return {
    name,
    async decide(req, ctx) {
      const base = (req.baseUrl ?? ctx.env(`${name.toUpperCase()}_BASE_URL`) ?? defaults.baseUrl)?.replace(/\/$/, "");
      if (!base) throw new Error(`${name} provider needs judge.baseUrl`);
      const key = req.apiKey ?? ctx.env(defaults.keyEnv);
      const model = req.model ?? ctx.env(`VERDICT_${name.toUpperCase()}_MODEL`) ?? defaults.model;
      const data = await postJson(ctx, `${base}${defaults.path ?? "/systemone"}`, { model, state: req.state, questions: req.questions, ...requestExtras(req.options) }, key ? { authorization: `Bearer ${key}` } : {});
      const d = defaults.unwrap ? defaults.unwrap(data) : data;
      const usage = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return { answers: (d.answers ?? {}) as Record<string, SystemOneAnswer>, model: (d.model as string) ?? model, usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
    },
  };
}

/** TypeSafe Jev — POST https://api.typesafe.ai/v1/systemone */
export const typesafeProvider = systemOneAdapter("typesafe", { baseUrl: "https://api.typesafe.ai/v1", keyEnv: "TYPESAFE_API_KEY", model: "jev-latest" });

/** Any endpoint that speaks the System One request shape (self-hosted Clef, DigitalOcean Inference, gateways). */
export const systemOneProvider = systemOneAdapter("systemone", { keyEnv: "SYSTEMONE_API_KEY", model: "jev-latest" });

/** OpenRouter decisions endpoint (model ids like typesafe/jev-1.13, inception/mercury-decide). */
export const openrouterProvider = systemOneAdapter("openrouter", { baseUrl: "https://openrouter.ai/api/alpha", keyEnv: "OPENROUTER_API_KEY", model: "typesafe/jev-1.13", path: "/decisions" });

/**
 * Cloudflare Workers AI — Clef / Clef-flash (System One-compatible body + Clef extensions).
 * Per the model pages: body needs `model: "clef" | "clef-flash"` (selector, not the @cf id), `state`, `questions`
 * (1–64, ids [A-Za-z0-9_.-]{1,100}); optional `images` (≤4 embedded PNG/JPEG/WebP). REST wraps the answer in `result`.
 * Context: clef 65,536 tokens ($0.24/M input), clef-flash 24,576 tokens ($0.038/M input); output tokens are free.
 */
export const cloudflareDecisionProvider: DecisionProviderAdapter = {
  name: "cloudflare",
  acceptsImages: true,
  maxImages: 4,
  async decide(req, ctx) {
    const account = (req.options?.accountId as string | undefined) ?? ctx.env("CLOUDFLARE_ACCOUNT_ID");
    const token = req.apiKey ?? ctx.env("CLOUDFLARE_API_TOKEN");
    const model = req.model ?? ctx.env("VERDICT_CLOUDFLARE_MODEL") ?? "@cf/cloudflare/clef-flash";
    const base = req.baseUrl?.replace(/\/$/, "") ?? (account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run` : undefined);
    if (!base) throw new Error("cloudflare provider needs CLOUDFLARE_ACCOUNT_ID (or judge.baseUrl pointing at an AI Gateway)");
    if (!token) throw new Error("cloudflare provider needs CLOUDFLARE_API_TOKEN (Workers AI: Read)");
    const selector = req.options?.selector as string | undefined;
    const extras = requestExtras(req.options);
    const images = [...(Array.isArray(extras.images) ? (extras.images as string[]) : []), ...(req.images ?? [])];
    checkClefImages(images);
    const body = { model: selector ?? model.split("/").pop(), state: req.state, questions: req.questions, ...extras, ...(images.length ? { images } : {}) };
    const data = await postJson(ctx, `${base}/${model}`, body, { authorization: `Bearer ${token}` });
    if (data.success === false) throw new Error(`cloudflare error: ${JSON.stringify(data.errors)}`);
    const d = (data.result ?? data) as Record<string, unknown>;
    const usage = d.usage as { input_tokens?: number; prompt_tokens?: number; output_tokens?: number } | undefined;
    return { answers: (d.answers ?? {}) as Record<string, SystemOneAnswer>, model, usage: { inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
  },
};

/** Clef limits (Workers AI model page, verified live 2026-11-05): ≤4 images, embedded data URIs, ≤4 MiB each, ≤8 MiB total. */
export function checkClefImages(images: string[]) {
  if (images.length > 4) throw new Error(`Clef accepts at most 4 images per request (got ${images.length})`);
  let total = 0;
  for (const [i, uri] of images.entries()) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(uri)) throw new Error(`image ${i + 1} must be an embedded PNG/JPEG/WebP data URI`);
    const bytes = Math.floor(((uri.length - uri.indexOf(",") - 1) * 3) / 4);
    if (bytes > 4 * 1024 * 1024) throw new Error(`image ${i + 1} is ${(bytes / 1048576).toFixed(1)} MiB; Clef allows 4 MiB per image`);
    total += bytes;
  }
  if (total > 8 * 1024 * 1024) throw new Error(`images total ${(total / 1048576).toFixed(1)} MiB; Clef allows 8 MiB per request`);
}

/**
 * OpenAI Decisions API — POST /v1/decisions (public beta, gpt-6-luna). Question types: predicate | choice | score.
 * Field names follow public write-ups and are parsed defensively; pin `baseUrl`/`options` if the beta shape differs.
 */
export const openaiDecisionsProvider: DecisionProviderAdapter = {
  name: "openai",
  async decide(req, ctx) {
    const base = (req.baseUrl ?? ctx.env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const key = req.apiKey ?? ctx.env("OPENAI_API_KEY");
    const model = req.model ?? ctx.env("VERDICT_OPENAI_DECISIONS_MODEL") ?? "gpt-6-luna";
    const questions = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, q.type === "noul" ? { type: "predicate", instructions: q.instructions, criteria: q.criteria } : q]));
    const data = await postJson(ctx, `${base}/decisions`, { model, state: req.state, questions, ...requestExtras(req.options) }, key ? { authorization: `Bearer ${key}` } : {});
    const answers: Record<string, SystemOneAnswer> = {};
    for (const [id, a] of Object.entries((data.answers ?? data.decisions ?? {}) as Record<string, Record<string, unknown>>)) {
      answers[id] = { ...(a as SystemOneAnswer), noul: (a.noul ?? a.predicate ?? a.probability) as number | undefined };
    }
    const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return { answers, model: (data.model as string) ?? model, usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 }, raw: data };
  },
};

/** Deterministic fake. options.level (index) / options.normalized / options.probabilities / options.noul, else a length heuristic. */
export const mockDecisionProvider: DecisionProviderAdapter = {
  name: "mock",
  acceptsImages: true,
  async decide(req, ctx) {
    const answers: Record<string, SystemOneAnswer> = {};
    const o = req.options ?? {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const words = new Set(req.state.toLowerCase().match(/\w+/g) ?? []);
        const options = Object.keys(q.criteria);
        const hits = options.map(o => (q.criteria[o] ?? "").toLowerCase().match(/\w+/g)?.filter(w => words.has(w)).length ?? 0);
        const choice = typeof o.choice === "string" ? o.choice : options[hits.indexOf(Math.max(...hits))]!;
        answers[id] = { type: "choice", choice, probabilities: Object.fromEntries(options.map(k => [k, k === choice ? 1 : 0])), confidence: 1 };
        continue;
      }
      if (q.type === "noul") {
        const p = typeof o.noul === "number" ? o.noul : typeof o.normalized === "number" ? o.normalized : /\b(lorem ipsum|test message|spam)\b/i.test(req.state) ? 0.1 : /\b(yes|pass|present)\b/i.test(req.state) ? 0.9 : 0.75;
        answers[id] = { type: "noul", noul: p };
        continue;
      }
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
      answers[id] = { type: "score", score, probabilities: probs, confidence: (Math.max(...probs) - 1 / n) / (1 - 1 / n), legend: q.criteria };
    }
    return { answers, model: "mock-decision", usage: { inputTokens: Math.ceil(req.state.length / 4) + 50 * Object.keys(req.questions).length, outputTokens: 0 }, raw: { images: req.images?.length ?? 0 } };
  },
};

for (const p of [typesafeProvider, systemOneProvider, openrouterProvider, cloudflareDecisionProvider, openaiDecisionsProvider, mockDecisionProvider]) registerDecisionProvider(p);
