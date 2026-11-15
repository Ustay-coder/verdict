/**
 * The demonstration: invented application documents, two versions of a one-criterion rubric, and a mock judge that
 * answers from a script. Nothing here is a real applicant or a model's judgement, and everything it creates is
 * marked `demo`. Test 1 has the script answer as the rubric intends; test 2 has it answer wrongly on purpose, fail
 * one call, quote a sentence the document does not contain, and store one self-contradicting result, so every way a
 * check can come out is visible.
 */
import type { Engine } from "../engine.js";
import type { Evaluation } from "../schema/evaluation.js";
import { createDatasetVersion } from "../versions/dataset.js";
import { freezeRubric, type RubricVersion } from "../versions/rubric-version.js";
import type { ChangeWorkbench } from "./store.js";
import { createChangeTest, type ChangeActor } from "./tests.js";
import { createTrial, executeTrial } from "./trial.js";
import type { ChangeTest, Trial } from "./types.js";

const CRITERION = "customer_validation";
const QUESTION = "확보한 고객 중 유료 계약 고객은 몇 곳이며, 무료 실증 고객은 몇 곳인가요?";

const DOCUMENTS: Record<string, { name: string; lines: string[] }> = {
  A: { name: "A · 유료 고객 3곳", lines: ["당사는 2026년 9월 기준 서로 다른 고객 3곳과 거래하고 있습니다.", "3곳 모두 유료 계약 고객입니다(한빛물류, 새봄식품, 다온제조와 연간 이용 계약을 체결하고 월 이용료를 받고 있습니다)."] },
  B: { name: "B · 무료 실증 고객 3곳", lines: ["당사는 2026년 9월 기준 서로 다른 고객 3곳을 확보했습니다.", "3곳 모두 무료 실증(PoC) 고객이며, 유료 계약 고객은 0곳입니다.", "실증이 끝나면 유료 전환을 협의할 예정입니다."] },
  C: { name: "C · 고객 3곳, 유료 여부 미기재", lines: ["당사는 2026년 9월 기준 서로 다른 고객 3곳이 서비스를 사용하고 있습니다(가람유통, 도담교육, 미르헬스).", "고객별 계약 형태와 이용료는 이 서류에 적지 않았습니다."] },
  D: { name: "D · 유료 고객 5곳 (기대 미설정)", lines: ["당사는 2026년 9월 기준 서로 다른 고객 5곳과 거래하고 있습니다.", "5곳 모두 유료 계약 고객입니다."] },
  E: { name: "E · 판정자 호출 실패", lines: ["당사는 2026년 9월 기준 서로 다른 고객 4곳과 거래하고 있습니다.", "4곳 모두 유료 계약 고객입니다."] },
  F: { name: "F · 원문에 없는 인용", lines: ["당사는 2026년 9월 기준 서로 다른 고객 3곳과 거래하고 있습니다.", "3곳 모두 유료 계약 고객입니다."] },
  G: { name: "G · 모순된 저장 결과", lines: ["당사는 2026년 9월 기준 서로 다른 고객 3곳이 서비스를 사용하고 있습니다.", "고객별 계약 형태는 이 서류에 적지 않았습니다."] },
};

const marker = (id: string) => `[신청기업 ${id}] 고객 현황`;
const text = (id: string) => [marker(id), ...DOCUMENTS[id]!.lines].join("\n");
const cases = (ids: string[]) => ids.map((id) => ({ id, name: DOCUMENTS[id]!.name, inputs: [{ type: "text" as const, text: text(id), label: `신청서 ${id}` }], human: {}, note: "invented for the demo" }));

/** One script line: which options to answer for this document (candidate's first, then the baseline's), and why. */
const says = (id: string, choose: string[], rationale: string, quotes: number[] | string[]) => ({
  when: marker(id),
  answers: { [CRITERION]: { choose, rationale, quotes: quotes.map((q) => (typeof q === "number" ? DOCUMENTS[id]!.lines[q]! : q)) } },
});

const PAID = ["paid_3_or_more", "customers_3_or_more"], UNPAID = ["customers_3_paid_under_3", "customers_3_or_more"], OPEN = ["undetermined", "customers_3_or_more"];
const INTENDED = [
  says("A", PAID, "서류에 유료 계약 고객 3곳이 적혀 있다.", [1]),
  says("B", UNPAID, "서류에 고객 3곳이 적혀 있고, 3곳 모두 무료 실증이며 유료 계약 고객은 0곳이라고 적혀 있다.", [0, 1]),
  says("C", OPEN, "서류에 고객 3곳이 적혀 있으나, 각 고객이 유료 계약인지 무료 실증인지는 적혀 있지 않다.", [0, 1]),
];
const WRONG = [
  INTENDED[0]!,
  says("B", PAID, "(틀리게 답하도록 쓴 대본) 무료 실증 고객 3곳을 유료 고객으로 셌다.", [0]),
  says("C", ["total_under_3", "customers_3_or_more"], "(틀리게 답하도록 쓴 대본) 유료 여부를 묻지 않고 고객이 부족하다고 채점했다.", [0]),
  says("D", PAID, "서류에 유료 계약 고객 5곳이 적혀 있다.", [1]),
  { when: marker("E"), error: "scripted failure: the judge did not answer (HTTP 503)" },
  says("F", PAID, "서류에 유료 계약 고객 3곳이 적혀 있다.", ["유료 고객 10곳과 3년 계약을 체결했습니다."]),
  says("G", OPEN, "서류에 고객 3곳이 적혀 있으나 유료 여부는 적혀 있지 않다.", [0]),
];

const rubric = (version: "1" | "2", script: unknown) => ({
  name: "창업지원 서류 심사 · 고객 검증 (demo)", version, language: "ko",
  context: "창업지원 사업 신청 서류를 심사한다. 고객 수는 중복을 제거한 서로 다른 고객 수다. 서류에 적힌 내용만 근거로 삼는다.",
  scale: { type: "numeric", min: 0, max: 10 },
  defaultJudge: { type: "llm", provider: "mock", options: { script } },
  aggregation: { normalize: [0, 10] },
  criteria: [version === "1" ? {
    id: CRITERION, name: "고객 검증", description: "유료 여부와 관계없이 서로 다른 고객이 3곳 이상인지 본다.",
    choices: { customers_3_or_more: "고객이 3곳 이상이다 (유료 여부와 관계없음)", customers_under_3: "고객이 3곳 미만이다", customer_count_unknown: "서류에서 고객 수를 확인할 수 없다" },
    values: { customers_3_or_more: 10, customers_under_3: 0 },
    unresolved: { customer_count_unknown: { state: "needs_info", requests: [{ field: "customer_count", question: "현재 확보한 서로 다른 고객은 몇 곳인가요?" }] } },
  } : {
    id: CRITERION, name: "고객 검증", description: "유료 고객 확보와 무료 실증을 구분한다. 확인되지 않은 유료 고객 수를 0으로 가정하지 않는다.",
    choices: {
      paid_3_or_more: "유료 고객이 3곳 이상이다", customers_3_paid_under_3: "전체 고객은 3곳 이상이고, 유료 고객이 3곳 미만임이 서류에서 확인된다",
      total_under_3: "전체 고객이 3곳 미만이다", undetermined: "서류의 정보로는 위 조건 중 어느 것에 해당하는지 정할 수 없다",
    },
    values: { paid_3_or_more: 10, customers_3_paid_under_3: 6, total_under_3: 0 },
    unresolved: { undetermined: { state: "needs_info", requests: [{ field: "customer_payment_status", question: QUESTION }] } },
  }],
});

const HOLD = [{ type: "hold", criterion: CRITERION, tolerance: 0 }];
const DROP = [{ type: "decrease", criterion: CRITERION, by: 4 }, { type: "range", criterion: CRITERION, min: 6, max: 6 }];
const ASK = [{ type: "asks_for", criterion: CRITERION, fields: ["customer_payment_status"] }, { type: "state", criterion: CRITERION, state: "needs_info" }];
const INTENT = "유료 고객 확보와 무료 실증을 구분한다. 구분에 필요한 정보가 없으면 확인하고 판단한다.";

export interface DemoResult { tests: Array<{ test: ChangeTest; trial: Trial; created: boolean }> }

/** Creates the two demo tests and runs one trial of each. Tests that are already there are returned as they are. */
export async function seedChangeDemo(engine: Engine, store: ChangeWorkbench, actor: ChangeActor = {}): Promise<DemoResult> {
  const specs: Array<{ name: string; script: unknown; ids: string[]; expected: Record<string, unknown[]>; engine: Engine }> = [
    { name: "Demo 1 · 유료 고객 구분 — the scripted judge answers as intended", script: INTENDED, ids: ["A", "B", "C"], expected: { A: HOLD, B: DROP, C: ASK }, engine },
    { name: "Demo 2 · 유료 고객 구분 — the scripted judge answers wrongly on purpose", script: WRONG, ids: ["A", "B", "C", "D", "E", "F", "G"], expected: { A: HOLD, B: DROP, C: ASK, E: HOLD, F: HOLD, G: ASK }, engine: contradicting(engine, store, "G") },
  ];
  const existing = await store.listChangeTests({ tenantId: actor.tenantId, limit: 500 });
  const tests: DemoResult["tests"] = [];
  for (const spec of specs) {
    const found = existing.find((t) => t.demo && t.name === spec.name);
    const trials = found ? await store.listTrials({ testId: found.id, tenantId: actor.tenantId }) : [];
    if (found && trials[0]) { tests.push({ test: found, trial: trials[0], created: false }); continue; }
    const [baseline, candidate] = await Promise.all((["1", "2"] as const).map((v) => keep(store, rubric(v, spec.script), actor)));
    const dataset = await createDatasetVersion(cases(spec.ids), { name: `demo documents ${spec.ids.join("")}`, ...(actor.tenantId ? { tenantId: actor.tenantId } : {}), now: actor.now });
    if (!(await store.getDatasetVersion(dataset.id, actor.tenantId))) await store.putDatasetVersion(dataset);
    const test = found ?? await createChangeTest(store, { name: spec.name, intent: INTENT, baselineVersionId: baseline!.id, candidateVersionId: candidate!.id, datasetVersionId: dataset.id, cases: spec.expected, demo: true }, actor);
    const { trial } = await createTrial(store, test.id, candidate!.id, actor);
    tests.push({ test, trial: await executeTrial(spec.engine, store, trial.id, actor), created: true });
  }
  return { tests };
}

async function keep(store: ChangeWorkbench, document: unknown, actor: ChangeActor): Promise<RubricVersion> {
  const version = await freezeRubric(document, { ...(actor.tenantId ? { tenantId: actor.tenantId } : {}), now: actor.now });
  const stored = await store.getRubricVersion(version.id, actor.tenantId);
  if (!stored) await store.putRubricVersion(version);
  return stored ?? version;
}

/**
 * A test-only faulty producer: the candidate's stored result for one case says "needs information" and also carries
 * a final score of 0. No judge returns this; it stands in for a broken integration so the output check can be seen.
 */
function contradicting(engine: Engine, store: ChangeWorkbench, caseId: string): Engine {
  const evaluate: Engine["evaluate"] = async (request, queued) => {
    const evaluation = await engine.evaluate(request, queued);
    const open = evaluation.criteria.find((c) => c.unresolved);
    if (evaluation.subject.metadata?.caseId !== caseId || !open) return evaluation;
    const broken: Evaluation = {
      ...evaluation, criteria: evaluation.criteria.map((c) => (c === open ? { ...c, score: 0, normalized: 0 } : c)),
      aggregate: { ...evaluation.aggregate, score: 0, raw: 0, partial: false },
    };
    await store.putEvaluation(broken);
    return broken;
  };
  return new Proxy(engine, { get: (target, key, receiver) => (key === "evaluate" ? evaluate : Reflect.get(target, key, receiver)) });
}
