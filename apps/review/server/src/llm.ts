/**
 * 구조화 출력(JSON 스키마)만 받는 작은 LLM 클라이언트. 요건 해석·사실 추출·OCR에 쓴다.
 * 판정 자체는 하지 않는다: 이 출력은 코드 검증을 통과한 부분만 Verdict 입력이 된다.
 * fetch는 주입된다(테스트는 오프라인).
 */
export class LlmError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "LlmError"; }
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "high" | "low" | "auto" } };

export interface LlmCall {
  name: string;
  system: string;
  user: string | ContentPart[];
  schema: Record<string, unknown>;
  model: string;
  maxTokens?: number;
}

export interface LlmClient {
  json<T>(call: LlmCall): Promise<{ data: T; model: string }>;
}

export interface OpenAiOptions {
  fetch?: typeof fetch;
  env?: (name: string) => string | undefined;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** OpenAI Chat Completions(구조화 출력). OPENAI_API_KEY, OPENAI_BASE_URL. */
export function openAiClient(opts: OpenAiOptions = {}): LlmClient {
  const env = opts.env ?? ((n: string) => process.env[n]);
  const doFetch = opts.fetch ?? fetch;
  const wait = opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return {
    async json<T>(call: LlmCall) {
      const base = (env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const key = env("OPENAI_API_KEY");
      const reasoning = /^(gpt-5|o\d)/.test(call.model);
      const body = {
        model: call.model,
        messages: [{ role: "system", content: call.system }, { role: "user", content: call.user }],
        response_format: { type: "json_schema", json_schema: { name: call.name, strict: true, schema: call.schema } },
        max_completion_tokens: call.maxTokens ?? 8000,
        ...(reasoning ? { reasoning_effort: "low" } : { temperature: 0 }),
      };
      let lastError: LlmError | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await wait(1000 * 2 ** attempt);
        let res: Response;
        try {
          res = await doFetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
          });
        } catch (e) { lastError = new LlmError(`모델 호출 실패: ${(e as Error).message}`, true); continue; }
        if (res.status === 429 || res.status >= 500) { lastError = new LlmError(`모델 호출 실패: HTTP ${res.status}`, true); continue; }
        const payload = (await res.json().catch(() => undefined)) as { model?: string; choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>; error?: { message?: string } } | undefined;
        if (!res.ok) throw new LlmError(`모델 호출 실패: HTTP ${res.status} ${payload?.error?.message ?? ""}`.trim());
        const choice = payload?.choices?.[0];
        if (choice?.message?.refusal) throw new LlmError(`모델이 응답을 거절했습니다: ${choice.message.refusal}`);
        if (choice?.finish_reason === "length") throw new LlmError("모델 응답이 길이 제한으로 잘렸습니다");
        const content = choice?.message?.content;
        if (!content) throw new LlmError("모델 응답이 비어 있습니다");
        try { return { data: JSON.parse(content) as T, model: payload?.model ?? call.model }; }
        catch { throw new LlmError("모델 응답이 JSON이 아닙니다"); }
      }
      throw lastError ?? new LlmError("모델 호출 실패");
    },
  };
}
