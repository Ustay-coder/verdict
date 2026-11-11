import { z } from "zod";
import { parseProvider, ProviderError } from "../../provider-error.js";
import { JUDGEMENT_JSON_SCHEMA, JudgementSchema, type Judgement, type LlmRequest } from "./contracts.js";

export function parseJudgement(text: string, provider: string): Judgement {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try { return parseProvider(provider, JudgementSchema, JSON.parse(body)); }
  catch (cause) {
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError(provider, "invalid judgement JSON", undefined, { cause });
  }
}

/** Keep the scoring instruction identical across chat transports. */
function messages(req: LlmRequest) {
  return [
    { role: "system", content: req.system + "\n\nRespond with a single JSON object with keys: score, confidence, rationale, quotes." },
    { role: "user", content: req.user },
  ];
}

export function openaiRequestBody(req: LlmRequest, model: string) {
  return {
    model, messages: messages(req),
    response_format: { type: "json_schema", json_schema: { name: "judgement", strict: true, schema: JUDGEMENT_JSON_SCHEMA } },
    max_tokens: req.maxTokens,
    ...(req.options ?? {}),
  };
}

export function cloudflareRequestBody(req: LlmRequest) {
  return {
    messages: messages(req),
    response_format: { type: "json_schema", json_schema: JUDGEMENT_JSON_SCHEMA },
    max_tokens: req.maxTokens,
    ...(req.options ?? {}),
  };
}

const OpenaiResponse = z.object({
  model: z.string().optional(), choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

export function parseOpenaiResponse(payload: unknown) {
  const data = parseProvider("openai", OpenaiResponse, payload);
  return {
    judgement: parseJudgement(data.choices[0]!.message.content, "openai"), model: data.model,
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 }, raw: data,
  };
}
