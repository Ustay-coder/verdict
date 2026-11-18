/** 오프라인 테스트 도구: 가짜 LLM(구조화 출력)과 System One(Jev) 응답을 주는 fetch. 실제 네트워크는 쓰지 않는다. */
import { Engine, MemoryStore } from "@verdict-ai/core";
import type { Extraction } from "../src/extract.js";
import type { LlmCall, LlmClient } from "../src/llm.js";
import type { ReviewSettings } from "../src/review.js";
import { EngineEventRouter } from "../src/runner.js";

export type Handler = (call: LlmCall) => unknown | Promise<unknown>;

export function fakeLlm(handlers: Record<string, Handler>): LlmClient & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    async json<T>(call: LlmCall) {
      calls.push(call);
      const h = handlers[call.name];
      if (!h) throw new Error(`no fake handler for ${call.name}`);
      return { data: (await h(call)) as T, model: `fake-${call.name}` };
    },
  };
}

export type Choice = "met" | "not_met" | "needs_review";

/** Jev System One 응답 흉내. state(검증된 사실 텍스트)를 보고 선택을 정한다. */
export function jevFetch(decide: (state: string, questionId: string) => Choice | "fail"): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const choice = decide(body.state, id);
      if (choice === "fail") return new Response(JSON.stringify({ error: "boom" }), { status: 400, headers: { "content-type": "application/json" } });
      const probabilities = { met: 0.02, not_met: 0.02, needs_review: 0.02, [choice]: 0.96 };
      answers[id] = { type: "choice", choice, confidence: 0.95, probabilities };
    }
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export function makeEngine(decide: (state: string, id: string) => Choice | "fail" = () => "met", router = new EngineEventRouter()) {
  const engine = new Engine({ store: new MemoryStore(), fetch: jevFetch(decide), env: (n) => (n === "TYPESAFE_API_KEY" ? "test-key" : undefined), onEvent: router.handler });
  return { engine, router };
}

export const SETTINGS: ReviewSettings = { llmModel: "fake", textJudge: { provider: "typesafe", model: "jev-latest" } };

export function textExtraction(...pages: string[]): Extraction {
  return { kind: "pdf", pages: pages.map((text, i) => ({ page: i + 1, text, source: "text" as const })), warnings: [], chars: pages.join("").length };
}

/** 컴파일러용 모델 출력 한 요건. */
export function rawReq(p: Partial<{ id: string; text: string; kind: string; subject: string; meaning: string; comparator: string | null; threshold: number | null; unit: string | null; years: number | null; months: number | null; days: number | null; referenceDate: string | null; thresholdDate: string | null; ambiguities: string[] }>) {
  return { id: "a", text: "", kind: "text", subject: "", meaning: "", comparator: null, threshold: null, unit: null, years: null, months: null, days: null, referenceDate: null, thresholdDate: null, ambiguities: [], ...p };
}
