import { describe, expect, it } from "vitest";
import { Engine, MemoryStore, observeTrial, seedChangeDemo, trialConditions, type Trial } from "../src/index.js";

async function demo() {
  const store = new MemoryStore();
  const engine = new Engine({ store });
  const { tests } = await seedChangeDemo(engine, store);
  return { store, engine, intended: tests[0]!, wrong: tests[1]! };
}

const verdicts = (trial: Trial) => Object.fromEntries(Object.entries(trial.verifications.at(-1)!.cases).map(([id, v]) => [id, v.status]));

describe("the change-test demo", () => {
  it("reproduces A held at 10, B dropping 10 → 6 and C asking for the payment status, all as expected", async () => {
    const { store, intended } = await demo();
    const { test, trial } = intended;
    expect(test.demo).toBe(true);
    expect(trial.status).toBe("completed");
    expect(verdicts(trial)).toEqual({ A: "met", B: "met", C: "met" });
    const seen = await observeTrial(store, test, trial);
    const row = (id: string) => { const c = seen.cases.find((x) => x.caseId === id)!; return { base: c.base.criteria[0]!, head: c.head.criteria[0]!, total: c.head.total! }; };
    expect(row("A")).toMatchObject({ base: { score: 10, state: "scored" }, head: { score: 10, state: "scored", range: [0, 10] }, total: { score: 10 } });
    expect(row("B")).toMatchObject({ base: { score: 10 }, head: { score: 6, state: "scored" }, total: { score: 6 } });
    // C's score is open: null, not 0, on the criterion and on the total; the question is the rubric's.
    const c = row("C");
    expect(c.base).toMatchObject({ score: 10, state: "scored" });
    expect(c.head).toMatchObject({ score: null, normalized: null, state: "needs_info", requests: [{ field: "customer_payment_status", question: expect.stringContaining("유료 계약 고객은 몇 곳") }] });
    expect(c.total).toMatchObject({ score: null, openCriteria: ["customer_validation"], missingPolicy: "exclude" });
    const b = trial.verifications[0]!.cases.B!.expectations;
    expect(b.map((e) => [e.status, e.code])).toEqual([["met", "decreased"], ["met", "in_range"]]);
    expect(b[0]!.observed).toEqual({ base: 10, head: 6, delta: -4 });
    expect(trial.verifications[0]!.cases.C!.expectations[0]!.observed).toMatchObject({ head: null, state: "needs_info", fields: ["customer_payment_status"] });
    // The stored evaluation itself has no score for C.
    const stored = await store.getEvaluation(trial.candidate.cases.find((x) => x.caseId === "C")!.evaluationId!);
    expect(stored!.criteria[0]).toMatchObject({ status: "scored", choice: "undetermined", unresolved: { state: "needs_info" } });
    expect(stored!.criteria[0]!.score).toBeUndefined();
    expect(stored!.aggregate).toMatchObject({ partial: true, unresolved: ["customer_validation"] });
    expect(stored!.aggregate.score).toBeUndefined();
  });

  it("ties quotes to the document, and says the run is a scripted mock under the same conditions", async () => {
    const { store, intended, wrong } = await demo();
    const seen = await observeTrial(store, intended.test, intended.trial);
    const quote = seen.cases.find((c) => c.caseId === "B")!.head.criteria[0]!.quotes[1]!;
    expect(quote).toMatchObject({ text: "3곳 모두 무료 실증(PoC) 고객이며, 유료 계약 고객은 0곳입니다.", location: { inputIndex: 0, line: 3 } });
    expect(await trialConditions(seen)).toMatchObject({ rubricOnly: true, differences: [], mock: true, scripted: true });
    const faulty = await observeTrial(store, wrong.test, wrong.trial);
    const f = faulty.cases.find((c) => c.caseId === "F")!.head.criteria[0]!;
    expect(f.quotes).toEqual([{ text: "유료 고객 10곳과 3년 계약을 체결했습니다." }]);
  });

  it("shows scripted wrong answers as mismatches with their reasons, and never as a pass", async () => {
    const { wrong } = await demo();
    const { trial } = wrong;
    expect(trial.status).toBe("partial");
    expect(verdicts(trial)).toEqual({ A: "met", B: "unmet", C: "unmet", D: "unverified", E: "incomparable", F: "met", G: "incomparable" });
    const v = trial.verifications[0]!;
    expect(v.cases.B!.expectations.map((e) => e.code)).toEqual(["not_decreased", "out_of_range"]);
    expect(v.cases.B!.expectations[0]!.message).toBe("customer_validation went 10 → 10 (0); expected a drop of at least 4");
    expect(v.cases.C!.expectations.map((e) => [e.status, e.code])).toEqual([["unmet", "not_asked"], ["unmet", "state_differs"]]);
    expect(v.cases.C!.expectations[0]!.message).toBe("customer_validation scored 0 and asks nothing; expected a request for customer_payment_status");
    expect(v.cases.E!.expectations[0]).toMatchObject({ status: "incomparable", code: "candidate_failed", message: expect.stringContaining("scripted failure") });
    expect(v.cases.G!.expectations[0]).toMatchObject({ status: "incomparable", code: "candidate_invalid_output", message: expect.stringContaining("yet a score of 0 is stored") });
    // Three separate tallies; the rate's denominator is the verifiable cases only.
    expect(v.summary).toMatchObject({
      cases: 7, execution: { evaluated: 5, failed: 2, unfinished: 0 },
      verification: { met: 2, unmet: 2, needs_review: 0, incomparable: 2, unverified: 1, verifiable: 4 },
      judgment: { scored: 5, needs_info: 0, abstained: 0, none: 2, newlyNeedsInfo: 0 },
    });
  });

  it("returns the tests it made before instead of making them again", async () => {
    const store = new MemoryStore();
    const engine = new Engine({ store });
    const first = await seedChangeDemo(engine, store);
    const again = await seedChangeDemo(engine, store);
    expect(again.tests.map((t) => [t.test.id, t.trial.id, t.created])).toEqual(first.tests.map((t) => [t.test.id, t.trial.id, false]));
    expect((await store.listChangeTests()).length).toBe(2);
  });
});
