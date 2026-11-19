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
/** 선택지 키 그대로, 또는 { choice, p }(고른 선택지 확률). "fail"이면 HTTP 400. */
export type Decide = (state: string, questionId: string, question: { instructions: string; criteria: Record<string, string> }) => string | { choice: string; p: number } | "fail";

/** Jev System One 응답 흉내. 질문의 선택지(criteria)에 맞춰 확률을 만든다. */
export function jevFetch(decide: Decide): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const d = decide(body.state, id, q);
      if (d === "fail") return new Response(JSON.stringify({ error: "boom" }), { status: 400, headers: { "content-type": "application/json" } });
      const { choice, p } = typeof d === "string" ? { choice: d, p: 0.96 } : d;
      const keys = Object.keys(q.criteria);
      const rest = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
      answers[id] = { type: "choice", choice, confidence: p, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : rest])) };
    }
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export function makeEngine(decide: Decide = () => "met", router = new EngineEventRouter()) {
  const engine = new Engine({ store: new MemoryStore(), fetch: jevFetch(decide), env: (n) => (n === "TYPESAFE_API_KEY" ? "test-key" : undefined), onEvent: router.handler });
  return { engine, router };
}

/** 후보 선택 질문에서 설명에 needle이 들어간 선택지를 고른다(없으면 none). 서술형은 verdict, 근거 줄은 needle이 있는 줄. */
export function pickBy(needles: Record<string, string>, opts: { verdict?: Choice; p?: number } = {}): Decide {
  return (state, id, q) => {
    const p = opts.p ?? 0.96;
    const base = id.replace(/_ev$/, "");
    const needle = needles[base];
    if ("met" in q.criteria && !id.endsWith("_ev")) return { choice: opts.verdict ?? "met", p };
    if (!needle) return { choice: "none", p };
    const lines = state.split("\n");
    const hit = Object.entries(q.criteria).find(([k, desc]) => {
      if (k === "none") return false;
      const m = /\[L(\d+)\]/.exec(desc);
      const line = m ? lines.find((l) => l.startsWith(`[L${m[1]}]`)) ?? "" : "";
      return id.endsWith("_ev") ? line.includes(needle) : desc.includes(needle);
    });
    return { choice: hit?.[0] ?? "none", p };
  };
}

export const SETTINGS: ReviewSettings = { mode: "full", llmModel: "fake", textJudge: { provider: "typesafe", model: "jev-latest" } };
export const HYBRID: ReviewSettings = { ...SETTINGS, mode: "hybrid", fastMinConfidence: 0.8 };

export function textExtraction(...pages: string[]): Extraction {
  return { kind: "pdf", pages: pages.map((text, i) => ({ page: i + 1, text, source: "text" as const })), warnings: [], chars: pages.join("").length };
}

/** 컴파일러용 모델 출력 한 요건. */
export function rawReq(p: Partial<{ id: string; text: string; kind: string; subject: string; meaning: string; comparator: string | null; threshold: number | null; unit: string | null; years: number | null; months: number | null; days: number | null; referenceDate: string | null; thresholdDate: string | null; ambiguities: string[] }>) {
  return { id: "a", text: "", kind: "text", subject: "", meaning: "", comparator: null, threshold: null, unit: null, years: null, months: null, days: null, referenceDate: null, thresholdDate: null, ambiguities: [], ...p };
}
