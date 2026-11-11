import { expect, it, vi } from "vitest";
import { anthropicProvider, cloudflareProvider, httpProvider, openaiCompatibleProvider, type LlmRequest } from "../src/judges/llm.js";
import { parseRubric } from "../src/schema/rubric.js";
import type { JudgeContext } from "../src/judges/types.js";

const judgement = { score: 7, confidence: 0.9, rationale: "Supported by evidence", quotes: ["hello"] };
const request: LlmRequest = { system: "Evaluate", user: "hello", maxTokens: 4000 };
function context(fetch: typeof globalThis.fetch, env: Record<string, string> = {}): JudgeContext {
  const rubric = parseRubric({ name: "Test", criteria: [{ id: "a", name: "A" }] });
  return { rubric, criterion: rubric.criteria[0]!, scale: rubric.scale, evidence: [], evaluationId: "e", env: name => env[name], fetch, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

it("sends structured OpenAI-compatible requests and parses fenced judgements", async () => {
  const fetch = vi.fn(async () => Response.json({ model: "fixture", choices: [{ message: { content: '```json\n' + JSON.stringify(judgement) + '\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const result = await openaiCompatibleProvider.complete({ ...request, options: { temperature: 0 } }, context(fetch, { OPENAI_BASE_URL: "https://gateway.test/v1/", OPENAI_API_KEY: "secret", OPENAI_MODEL: "fixture" }));
  expect(result.judgement).toEqual(judgement); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe("https://gateway.test/v1/chat/completions");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
  expect(JSON.parse(String(init.body))).toMatchObject({ model: "fixture", temperature: 0, response_format: { type: "json_schema" } });
});

it.each(["openai", "cloudflare", "http"])("surfaces %s transport failures", async provider => {
  const adapter = { openai: openaiCompatibleProvider, cloudflare: cloudflareProvider, http: httpProvider }[provider]!;
  const ctx = context(async () => new Response("unavailable", { status: 503 }));
  await expect(adapter.complete({ ...request, baseUrl: "https://fixture.test" }, ctx)).rejects.toThrow("HTTP 503");
});

it("handles Cloudflare response objects, response strings and provider errors", async () => {
  const fetch = vi.fn(async () => Response.json({ success: true, result: { response: judgement, usage: { prompt_tokens: 4, completion_tokens: 2 } } }));
  const result = await cloudflareProvider.complete(request, context(fetch, { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "secret" }));
  expect(result.judgement).toEqual(judgement); expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  const ctx = context(async () => Response.json({ result: { response: JSON.stringify(judgement) } }));
  expect((await cloudflareProvider.complete({ ...request, baseUrl: "https://gateway.test", model: "fixture" }, ctx)).judgement).toEqual(judgement);
  await expect(cloudflareProvider.complete(request, ctx)).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
  await expect(cloudflareProvider.complete({ ...request, baseUrl: "https://gateway.test" }, context(async () => Response.json({ success: false, errors: ["invalid"] })))).rejects.toThrow("invalid");
});

it("uses the generic HTTP contract and fills optional judgement fields", async () => {
  const fetch = vi.fn(async () => Response.json({ score: 4, model: "fixture" }));
  const result = await httpProvider.complete(request, context(fetch, { VERDICT_HTTP_JUDGE_URL: "https://fixture.test", VERDICT_HTTP_JUDGE_KEY: "secret" }));
  expect(result.judgement).toEqual({ score: 4, confidence: 0.5, rationale: "", quotes: [] });
  expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  await expect(httpProvider.complete(request, context(fetch))).rejects.toThrow("baseUrl");
  await expect(httpProvider.complete({ ...request, baseUrl: "https://fixture.test" }, context(async () => Response.json({ score: "invalid" })))).rejects.toThrow();
});

it("parses Anthropic structured responses using the injected fetch", async () => {
  const fetch = vi.fn(async () => Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: JSON.stringify(judgement) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }));
  const result = await anthropicProvider.complete({ ...request, apiKey: "test", model: "fixture" }, context(fetch));
  expect(result.judgement).toEqual(judgement);
  expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 5 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("builds and parses chat protocol data without transport dependencies", async () => {
  const { openaiRequestBody, cloudflareRequestBody, parseOpenaiResponse, parseJudgement } = await import("../src/judges/llm/protocol.js");
  const body = openaiRequestBody({ ...request, options: { temperature: 0 } }, "fixture");
  expect(body).toMatchObject({ model: "fixture", temperature: 0, max_tokens: 4000 });
  expect(cloudflareRequestBody(request).messages).toEqual(body.messages);
  expect(parseOpenaiResponse({ choices: [{ message: { content: JSON.stringify(judgement) } }] })).toMatchObject({ judgement, usage: { inputTokens: 0, outputTokens: 0 } });
  expect(() => parseOpenaiResponse({ choices: [] })).toThrow("openai");
  expect(() => parseJudgement("not JSON", "fixture")).toThrow("fixture: invalid judgement JSON");
});
