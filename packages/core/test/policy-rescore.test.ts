import { describe, expect, it } from "vitest";
import {
  compareRuns, createDatasetVersion, Engine, freezeRubric, MemoryStore, policyRescoreBlocker, rescoreRunUnder, runCases,
  type GoldItem, type Rating,
} from "../src/index.js";

// The mock judge answers P(yes) = 0.7 for every case: yes at a 0.6 threshold, no at 0.75.
const card = (threshold: number, extra: Record<string, unknown> = {}) => ({
  name: "Wants an agent",
  defaultJudge: { type: "decision", provider: "mock", options: { noul: 0.7 }, ...extra },
  criteria: [{ id: "wants", name: "Does the customer want an agent?", scale: { type: "binary", labels: ["no", "yes"] }, threshold }],
});
const cases: GoldItem[] = [
  { id: "a", name: "a", inputs: [{ type: "text", text: "상담원 연결" }], expected: { wants: "yes" } },
  { id: "b", name: "b", inputs: [{ type: "text", text: "사람과 통화" }], expected: { wants: "no" } },
];

async function baseRun() {
  const engine = new Engine({ store: new MemoryStore() });
  const base = await freezeRubric(card(0.6));
  const dataset = await createDatasetVersion(cases);
  const { run, evaluations } = await runCases(engine, base, dataset);
  return { engine, base, dataset, source: { run, version: base, evaluations } };
}

const decision = (r: Rating | undefined) => r as Rating<"decision">;

describe("re-scoring a run under another policy", () => {
  it("reads the recorded answers under the new threshold without asking the judge, as a real run would store them", async () => {
    const t = await baseRun();
    const head = await freezeRubric(card(0.75), { parent: t.base });
    expect(policyRescoreBlocker(t.base, head)).toBeUndefined();
    const { run, evaluations, report } = await rescoreRunUnder(t.engine, t.source, head, t.dataset);

    expect(run).toMatchObject({ rubricVersionId: head.id, rescoredFrom: t.source.run.id, usage: { decisionCalls: 0, inputTokens: 0, outputTokens: 0 } });
    expect(run.fingerprint).toMatchObject({ policyHash: head.policyHash, questionsHash: t.source.run.fingerprint.questionsHash, models: t.source.run.fingerprint.models });
    const rating = decision(evaluations[0]!.criteria[0]!.ratings[0]);
    expect(rating).toMatchObject({ raterId: decision(t.source.evaluations[0]!.criteria[0]!.ratings[0]).raterId, score: 0, probabilities: { yes: 0.7 } });
    expect(rating.raw).toMatchObject({ provider: "mock", model: "mock-decision", threshold: 0.75, thresholdSource: "rubric" });
    expect(rating.rationale).toMatch(/^mock\/mock-decision distribution/);
    expect(evaluations[0]!.rubric).toEqual(head.rubric);
    expect(await t.engine.store.getEvaluation(evaluations[0]!.id)).toEqual(evaluations[0]);
    expect(report.criteria.wants).toMatchObject({ n: 2, agreed: 1 });

    const cmp = compareRuns(t.source, { run, version: head, evaluations }, t.dataset);
    expect(cmp.kind).toBe("policy_change");
    expect(cmp.conditions.diffs.map((d) => d.field)).toEqual(["policyHash"]);
    expect(cmp.criteria[0]!.counts).toMatchObject({ regressed: 1, fixed: 1 });
  });

  it("applies the new low-confidence rule: a now-unsure answer goes to a person", async () => {
    const t = await baseRun();
    const head = await freezeRubric(card(0.65, { minConfidence: 0.5, onLowConfidence: "human", escalateTo: ["alice"] }));
    const { evaluations } = await rescoreRunUnder(t.engine, t.source, head, t.dataset);
    expect(evaluations[0]!.status).toBe("pending_human");
    const pending = evaluations[0]!.criteria[0]!.ratings[0]!;
    expect(pending).toMatchObject({ judgeType: "human", status: "pending", raterId: "alice" });
    expect((pending.raw as { escalatedFrom: Rating }).escalatedFrom.rationale).toMatch(/^mock\/mock-decision distribution/);
  });

  it("refuses what replaying cannot answer, saying why", async () => {
    const t = await baseRun();
    const reworded = await freezeRubric({ ...card(0.75), criteria: [{ ...card(0.75).criteria[0]!, name: "Does the customer ask for a person?" }] });
    expect(policyRescoreBlocker(t.base, reworded)).toBe("the questions differ, so the judges have to be asked again");
    await expect(rescoreRunUnder(t.engine, t.source, reworded, t.dataset)).rejects.toThrow(/cannot re-score run_\w+ as rv_\w+: the questions differ/);
    const otherModel = await freezeRubric(card(0.75, { model: "other" }));
    expect(policyRescoreBlocker(t.base, otherModel)).toBe("the judges' providers or models differ");
    expect(policyRescoreBlocker(t.base, t.base)).toBe("the policy is the same");
    const otherCases = await createDatasetVersion([{ ...cases[0]!, inputs: [{ type: "text", text: "changed" }] }, cases[1]!]);
    await expect(rescoreRunUnder(t.engine, t.source, await freezeRubric(card(0.75)), otherCases)).rejects.toThrow(/the cases' inputs changed/);
    // A recording without an answer (here, wiped) cannot be replayed.
    const broken = { ...t.source, evaluations: t.source.evaluations.map((e) => ({ ...e, criteria: e.criteria.map((c) => ({ ...c, ratings: [] })) })) };
    await expect(rescoreRunUnder(t.engine, broken, await freezeRubric(card(0.75)), t.dataset)).rejects.toThrow(/has no recorded answer for wants/);
  });
});
