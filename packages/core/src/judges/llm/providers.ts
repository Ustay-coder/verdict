import { parseJudgement, openaiRequestBody, cloudflareRequestBody, parseOpenaiResponse } from "./protocol.js";
/**
 * Adapts generative provider transports to the shared judgement contract.
 * Untrusted envelopes are checked before mapping; provider credentials come from environment references.
 */
import { z } from "zod";
import { parseProvider, ProviderError, readProviderJson, fetchProvider } from "../../provider-error.js";
import { scaleRange } from "../../aggregate/index.js";

import { JUDGEMENT_JSON_SCHEMA, JudgementSchema, type LlmProviderAdapter } from "./contracts.js";
import { registerLlmProvider } from "./registry.js";
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
    if (message.stop_reason === "refusal") throw new ProviderError("anthropic", `model declined to evaluate (${message.stop_details?.category ?? "refusal"})`);
    // why: older SDK responses may contain only text even when structured output was requested.
    const judgement = message.parsed_output ?? parseJudgement(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""), "anthropic");
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
    const res = await fetchProvider("openai", ctx.fetch, `${base}/chat/completions`, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(openaiRequestBody(req, req.model ?? ctx.env("OPENAI_MODEL") ?? "gpt-4o-mini")),
    });
    return parseOpenaiResponse(await readProviderJson("openai", res));
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
    if (!base) throw new ProviderError("cloudflare", "provider needs CLOUDFLARE_ACCOUNT_ID (or judge.baseUrl)");
    const res = await fetchProvider("cloudflare", ctx.fetch, `${base}/${model}`, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(cloudflareRequestBody(req)),
    });
    const data = parseProvider("cloudflare", z.object({
      result: z.object({ response: z.unknown(), usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional() }).optional(),
      success: z.boolean().optional(), errors: z.unknown().optional(),
    }), await readProviderJson("cloudflare", res));
    if (data.success === false) throw new ProviderError("cloudflare", `provider error: ${JSON.stringify(data.errors)}`);
    const r = data.result?.response;
    const judgement = typeof r === "string" ? parseJudgement(r, "cloudflare") : parseProvider("cloudflare", JudgementSchema, r);
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
    if (!url) throw new ProviderError("http", "provider needs judge.baseUrl (or VERDICT_HTTP_JUDGE_URL)");
    const key = req.apiKey ?? ctx.env("VERDICT_HTTP_JUDGE_KEY");
    const res = await fetchProvider("http", ctx.fetch, url, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ system: req.system, user: req.user, model: req.model, criterion: ctx.criterion, scale: ctx.scale, evidence: ctx.evidence, schema: JUDGEMENT_JSON_SCHEMA, options: req.options }),
    });
    const data = parseProvider("http", JudgementSchema.partial().extend({
      model: z.string().optional(), usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
    }), await readProviderJson("http", res));
    // why: the generic HTTP contract permits omitted confidence and rationale; supply neutral metadata, never a fabricated score.
    const judgement = parseProvider("http", JudgementSchema, { choice: data.choice, score: data.score, confidence: data.confidence ?? 0.5, rationale: data.rationale ?? "", quotes: data.quotes ?? [] });
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
      // why: a deterministic length/mention heuristic makes offline dry runs reproducible without claiming model confidence.
      const text = ctx.evidence.map((e) => e.text).join(" ").toLowerCase();
      const mention = text.includes(ctx.criterion.name.toLowerCase()) ? 0.3 : 0;
      const len = Math.min(1, text.length / 2000) * 0.5;
      score = lo + (hi - lo) * (0.2 + mention + len);
    }
    return { judgement: { choice: ctx.criterion.choices ? String(o.choice ?? Object.keys(ctx.criterion.choices)[0]) : undefined, score, confidence: 0.5, rationale: `mock judgement for ${ctx.criterion.id}`, quotes: [] }, model: "mock", usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: 50 } };
  },
};

for (const p of [anthropicProvider, openaiCompatibleProvider, cloudflareProvider, httpProvider, mockProvider]) registerLlmProvider(p);
