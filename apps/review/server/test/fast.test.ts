import { describe, expect, it } from "vitest";
import { validateCompiled } from "../src/compile.js";
import { buildFastPlan, candidatesFor, numberLines, MAX_OPTIONS } from "../src/fast.js";
import { reviewDocument } from "../src/review.js";
import { fakeLlm, HYBRID, makeEngine, pickBy, rawReq, textExtraction, type Decide } from "./helpers.js";

const SRC = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";
const compiled = validateCompiled(SRC, {
  requirements: [
    rawReq({ id: "a", text: "창업 3년 이상", kind: "elapsed", subject: "창업일", comparator: ">=", years: 3, referenceDate: "2025-12-31" }),
    rawReq({ id: "b", text: "울산 소재 기업", kind: "text", subject: "사업장 소재지", meaning: "사업장이 울산에 있음" }),
    rawReq({ id: "c", text: "2025년 매출 1억 원 이상", kind: "number", subject: "2025년 매출액", comparator: ">=", threshold: 100_000_000, unit: "원" }),
  ],
  logic: "a AND b AND c",
}, "m");

const doc = (open: string, city: string, rev25: string, rev24 = "80,000,000원") => textExtraction(
  `사업자등록증\n대표자 생년월일 : 1985. 02. 11.\n개업연월일 : ${open}\n사업장 소재지 : ${city}\n2025년 08월 15일 발급`,
  `손익계산서\n과목    2025년(당기)    2024년(전기)\nⅠ. 매출액    ${rev25}    ${rev24}`,
);

/** LLM 사실 추출이 불렸는지 센다(불리면 전체 읽기로 넘어간 것). */
function llmWith(facts: unknown[] = []) {
  return fakeLlm({ facts: () => ({ facts, missing: [] }) });
}
async function run(ex: ReturnType<typeof doc>, decide: Decide, llm = llmWith()) {
  const { engine } = makeEngine(decide);
  const events: Array<[string, string]> = [];
  const r = await reviewDocument({ compiled, extraction: ex, evaluationId: `ev_${Math.random()}`, docName: "a.pdf", runId: "run", docId: "d1" },
    { engine, llm, settings: HYBRID, onRequirement: (id, o) => events.push([id, o]) });
  return { r, events, llmCalls: llm.calls.length };
}

describe("hybrid review: fast path through one Verdict decision request", () => {
  it("decides without the LLM when the model picks candidates confidently; quotes are source lines", async () => {
    const { r, events, llmCalls } = await run(doc("2019년 03월 02일", "울산광역시 남구 삼산로 1", "120,000,000원"), pickBy({ r1: "2019-03-02", r2: "울산광역시", r3: "120,000,000원" }));
    expect(llmCalls).toBe(0);
    expect(r.method).toBe("fast");
    expect(r.verdict).toBe("met");
    expect(r.requirements.map((x) => x.outcome)).toEqual(["met", "met", "met"]);
    expect(r.requirements[0]!.facts[0]).toMatchObject({ quote: "개업연월일 : 2019년 03월 02일", page: 1, numeric: 20190302 });
    expect(r.requirements[2]!.facts[0]).toMatchObject({ quote: "Ⅰ. 매출액    120,000,000원    80,000,000원", page: 2, numeric: 120_000_000 });
    expect(r.requirements[1]!.facts[0]!.quote).toBe("사업장 소재지 : 울산광역시 남구 삼산로 1");
    expect(events).toEqual([["r1", "met"], ["r2", "met"], ["r3", "met"]]);
  });

  it("computes the comparison in code: picking the 2024 column or the issue date gives the code-computed result", async () => {
    const { r } = await run(doc("2023년 01월 01일", "울산광역시", "90,000,000원", "150,000,000원"), pickBy({ r1: "2023-01-01", r2: "울산광역시", r3: "90,000,000원" }));
    expect(r.method).toBe("fast");
    expect(r.requirements.map((x) => x.outcome)).toEqual(["not_met", "met", "not_met"]);
    expect(r.verdict).toBe("not_met");
  });

  it("escalates to the full LLM read when there is no candidate, the model says none, or confidence is low", async () => {
    const noRevenue = textExtraction("개업연월일 : 2019년 03월 02일\n사업장 소재지 : 울산광역시");
    const a = await run(noRevenue, pickBy({ r1: "2019-03-02", r2: "울산" }));
    expect(a.r.method).toBe("full");
    expect(a.llmCalls).toBe(1);
    expect(a.r.escalated!.join()).toMatch(/r3: 후보 값을 찾지 못함/);

    const none = await run(doc("2019년 03월 02일", "울산광역시", "120,000,000원"), pickBy({ r1: "2019-03-02", r2: "울산광역시" }));
    expect(none.r.escalated!.join()).toMatch(/r3: 판정 모델이 값을 고르지 못함/);
    expect(none.r.fastEvaluationId).toMatch(/_fast$/);

    const low = await run(doc("2019년 03월 02일", "울산광역시", "120,000,000원"), pickBy({ r1: "2019-03-02", r2: "울산광역시", r3: "120,000,000원" }, { p: 0.55 }));
    expect(low.r.method).toBe("full");
    expect(low.r.escalated!.join()).toMatch(/확신도 낮음/);
  });

  it("escalates text requirements without an evidence line or with needs_review, and on judge errors", async () => {
    const noEvidence = await run(doc("2019년 03월 02일", "울산광역시", "120,000,000원"), pickBy({ r1: "2019-03-02", r3: "120,000,000원" }));
    expect(noEvidence.r.escalated!.join()).toMatch(/r2: 근거 줄을 고르지 못함/);
    const unsure = await run(doc("2019년 03월 02일", "울산광역시", "120,000,000원"), pickBy({ r1: "2019-03-02", r2: "울산", r3: "120,000,000원" }, { verdict: "needs_review" }));
    expect(unsure.r.escalated!.join()).toMatch(/r2: 판정 모델이 값을 고르지 못함/);
    const broken = await run(doc("2019년 03월 02일", "울산광역시", "120,000,000원"), (s, id) => (id === "r1" ? "fail" : "met"));
    expect(broken.r.method).toBe("full");
    expect(broken.r.escalated!.join()).toMatch(/빠른 판정 실패/);
  });

  it("does not escalate requirements that are unresolved by their own wording (no reference date)", async () => {
    const c2 = validateCompiled("창업 3년 이상\n울산 소재 기업", { requirements: [rawReq({ id: "a", text: "창업 3년 이상", kind: "elapsed", comparator: ">=", years: 3 }), rawReq({ id: "b", text: "울산 소재 기업", subject: "사업장 소재지", meaning: "울산에 있음" })], logic: "a AND b" }, "m");
    const llm = llmWith();
    const { engine } = makeEngine(pickBy({ r2: "울산광역시" }));
    const r = await reviewDocument({ compiled: c2, extraction: doc("2019년 03월 02일", "울산광역시", "1원"), evaluationId: "e_unres", docName: "a", runId: "r", docId: "d" }, { engine, llm, settings: HYBRID });
    expect(r.method).toBe("fast");
    expect(llm.calls).toHaveLength(0);
    expect(r.requirements[0]).toMatchObject({ outcome: "needs_review", needed: [expect.stringMatching(/기준일/)] });
    expect(r.verdict).toBe("needs_review");
  });

  it("applies table units and shows NOT requirements from the requirement's side", async () => {
    const ex = textExtraction("개업연월일 : 2019-03-02\n사업장 소재지 : 서울특별시 마포구", "손익계산서\n(단위: 천원)\nⅠ. 매출액    150,000    90,000");
    const c3 = validateCompiled("서울 소재 기업\n2025년 매출 1억 원 이상", { requirements: [rawReq({ id: "x", text: "서울 소재 기업", subject: "사업장 소재지", meaning: "서울에 있음" }), rawReq({ id: "y", text: "2025년 매출 1억 원 이상", kind: "number", subject: "2025년 매출액", comparator: ">=", threshold: 100_000_000, unit: "원" })], logic: "NOT x AND y" }, "m");
    const { engine } = makeEngine(pickBy({ r1: "서울특별시", r2: "150,000,000원" }));
    const r = await reviewDocument({ compiled: c3, extraction: ex, evaluationId: "e_not", docName: "a", runId: "r", docId: "d" }, { engine, llm: llmWith(), settings: HYBRID });
    expect(r.method).toBe("fast");
    expect(r.requirements[0]).toMatchObject({ outcome: "not_met", condition: "met", negated: true });
    expect(r.requirements[1]!.facts[0]).toMatchObject({ numeric: 150_000_000, unitQuote: "(단위: 천원)" });
    expect(r.verdict).toBe("not_met");
  });

  it("keeps the request small: candidates are line references, relevant lines first, capped", () => {
    const filler = Array.from({ length: 300 }, (_, i) => `부록 ${i}: 장비 구매 ${(i + 1) * 1_000_000}원`).join("\n");
    const ex = textExtraction(filler, "Ⅰ. 매출액    120,000,000원");
    const lines = numberLines(ex);
    const { list, overflow } = candidatesFor(compiled.requirements[2]!, lines);
    expect(list.length).toBe(MAX_OPTIONS);
    expect(overflow).toBe(false);
    expect(list[0]!.line.text).toMatch(/매출액/);
    const plan = buildFastPlan(compiled, textExtraction("개업연월일 : 2019-03-02\n사업장 소재지 : 울산", "Ⅰ. 매출액 120,000,000원"), HYBRID.textJudge);
    expect("rubric" in plan).toBe(true);
    const choices = (plan as { rubric: { criteria: Array<{ id: string; choices?: Record<string, string> }> } }).rubric.criteria.find((c) => c.id === "r3")!.choices!;
    expect(Object.values(choices)[0]).toMatch(/^\[L\d+\] 120,000,000원$/);
  });

  it("does not offer dates, years or registration numbers as amounts", () => {
    const lines = numberLines(textExtraction("등록번호 : 610-81-10000\n개업연월일 : 2018-07-01\n2026년 3월 출시 예정\n전화 052-123-4567\n설립 2019. 3. 2."));
    expect(candidatesFor(compiled.requirements[2]!, lines).list).toEqual([]);
  });
});
