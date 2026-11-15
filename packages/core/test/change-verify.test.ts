import { describe, expect, it } from "vitest";
import {
  counterpart, Expectation, parseExpectations, parseRubric, rubricChanges, summarize, verifyCase, verifyExpectation,
  type CriterionObservation, type JudgmentState, type SideObservation,
} from "../src/index.js";

const rubric = (criteria: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => parseRubric({ name: "R", defaultJudge: { type: "decision", provider: "mock" }, criteria, ...extra });
const numeric = (id: string, max = 10, extra: Record<string, unknown> = {}) => ({ id, name: id, scale: { type: "numeric", min: 0, max }, ...extra });

const crit = (id: string, score: number | null, extra: Partial<CriterionObservation> = {}): CriterionObservation => ({
  criterionId: id, name: id, weight: 1, execution: "ok", state: score === null ? "needs_info" : "scored", score, range: [0, 10], normalized: score === null ? null : score / 10,
  requests: [], quotes: [], judges: [], ...extra,
});
const side = (criteria: CriterionObservation[], total: number | null = criteria[0]?.score ?? null, extra: Partial<SideObservation> = {}): SideObservation => {
  const states = criteria.map((c) => c.state);
  const state: JudgmentState | null = states.includes("needs_info") ? "needs_info" : states.includes("abstained") ? "abstained" : states.includes("scored") ? "scored" : null;
  return { execution: "completed", issues: [], state, criteria, total: { score: total, provisional: null, range: [0, 100], openCriteria: total === null ? criteria.filter((c) => c.score === null).map((c) => c.criterionId) : [], missingPolicy: "exclude" }, ...extra };
};
const failed = (execution: SideObservation["execution"], error = "HTTP 503"): SideObservation => ({ execution, error, issues: execution === "invalid_output" ? [{ code: "open_with_score", message: "q: needs info, yet a score of 0 is stored" }] : [], state: null, total: null, criteria: [] });
const exp = (raw: Record<string, unknown>) => ({ ...Expectation.parse(raw), id: "e1" });

const one = rubric([numeric("q")]);
const ctx = { base: one, head: one };
const check = (raw: Record<string, unknown>, base: number | null, head: number | null) => verifyExpectation(ctx, exp({ criterion: "q", ...raw }), { base: side([crit("q", base)]), head: side([crit("q", head)]) });

describe("verifying one expectation", () => {
  it("holds within the tolerance, on stored values", () => {
    expect(check({ type: "hold" }, 10, 10)).toMatchObject({ status: "met", code: "held", observed: { base: 10, head: 10, delta: 0 } });
    expect(check({ type: "hold" }, 10, 9)).toMatchObject({ status: "unmet", code: "not_held", message: "q went 10 → 9 (-1); expected no change" });
    expect(check({ type: "hold", tolerance: 1 }, 10, 9).status).toBe("met");
    expect(check({ type: "hold", tolerance: 0.5 }, 7, 7.6).status).toBe("unmet");
    // 0.1 + 0.2 is not 0.3 in floating point; a tolerance of exactly the difference still holds.
    expect(check({ type: "hold", tolerance: 0.2 }, 0.1, 0.1 + 0.2)).toMatchObject({ status: "met" });
  });

  it("tells a required rise or drop from one that only must not go the other way", () => {
    expect(check({ type: "decrease", by: 4 }, 10, 6)).toMatchObject({ status: "met", code: "decreased", observed: { delta: -4 } });
    expect(check({ type: "decrease", by: 4 }, 10, 7)).toMatchObject({ status: "unmet", message: "q went 10 → 7 (-3); expected a drop of at least 4" });
    expect(check({ type: "decrease" }, 10, 10)).toMatchObject({ status: "unmet", code: "not_decreased", message: expect.stringContaining("expected a drop") });
    expect(check({ type: "increase" }, 5, 5.5).status).toBe("met");
    expect(check({ type: "increase", by: 2 }, 5, 6).status).toBe("unmet");
    expect(check({ type: "not_lower" }, 5, 5).status).toBe("met");
    expect(check({ type: "not_lower" }, 5, 9).status).toBe("met");
    expect(check({ type: "not_lower" }, 5, 4)).toMatchObject({ status: "unmet", code: "not_not_lower" });
    expect(check({ type: "not_higher", tolerance: 1 }, 5, 6).status).toBe("met");
    expect(check({ type: "not_higher" }, 5, 6).status).toBe("unmet");
  });

  it("checks a range on the candidate alone", () => {
    expect(check({ type: "range", min: 6, max: 6 }, 10, 6)).toMatchObject({ status: "met", code: "in_range", observed: { head: 6 } });
    expect(check({ type: "range", min: 6, max: 8 }, 10, 9)).toMatchObject({ status: "unmet", message: "the candidate's q is 9; expected 6–8" });
    expect(() => Expectation.parse({ type: "range", min: 8, max: 6 })).toThrow();
  });

  it("never compares an open score as a number: no delta, no zero", () => {
    const open = check({ type: "decrease", by: 4 }, 10, null);
    expect(open).toMatchObject({ status: "incomparable", code: "candidate_undetermined", observed: { base: 10, head: null, delta: null, state: "needs_info" } });
    expect(check({ type: "hold" }, null, 10)).toMatchObject({ status: "incomparable", code: "baseline_undetermined" });
    expect(check({ type: "range", min: 0, max: 0 }, 10, null)).toMatchObject({ status: "incomparable", code: "candidate_undetermined" });
    // The same case's state expectation is still judged.
    expect(check({ type: "state", state: "needs_info" }, 10, null)).toMatchObject({ status: "met", code: "state_as_expected" });
    expect(check({ type: "state", state: "scored" }, 10, null)).toMatchObject({ status: "unmet", message: "q is needs information; expected scored" });
  });

  it("reads the total only when every counted criterion is scored", () => {
    const totals = (raw: Record<string, unknown>, base: number | null, head: number | null) => verifyExpectation(ctx, exp(raw), { base: side([crit("q", 10)], base), head: side([crit("q", head === null ? null : 6)], head) });
    expect(totals({ type: "decrease", by: 30 }, 100, 60)).toMatchObject({ status: "met", message: "total went 100 → 60 (-40); expected a drop of at least 30" });
    expect(totals({ type: "hold" }, 100, null)).toMatchObject({ status: "incomparable", message: expect.stringContaining("q is not scored") });
    expect(totals({ type: "state", state: "needs_info" }, 100, null)).toMatchObject({ status: "met", message: "the case is needs information; expected needs information" });
  });

  it("does not take a difference across a changed scale, and still checks what reads the candidate alone", () => {
    const base = rubric([numeric("q", 10)]), head = rubric([numeric("q", 20)]);
    const seen = { base: side([crit("q", 10)]), head: side([crit("q", 12, { range: [0, 20], normalized: 0.6 })]) };
    const delta = verifyExpectation({ base, head }, exp({ type: "increase", criterion: "q" }), seen);
    expect(delta).toMatchObject({ status: "incomparable", code: "scale_changed", message: expect.stringContaining("0–10 → 0–20"), observed: { base: 10, head: 12, delta: null } });
    expect(verifyExpectation({ base, head }, exp({ type: "range", criterion: "q", min: 10, max: 14 }), seen).status).toBe("met");
    // A total over another output range is not compared either.
    const ranged = { base: side([crit("q", 10)], 10), head: { ...side([crit("q", 12)], 60), total: { ...side([], 60).total!, range: [0, 50] as [number, number] } } };
    expect(verifyExpectation({ base, head }, exp({ type: "hold" }), ranged)).toMatchObject({ status: "incomparable", code: "scale_changed" });
  });

  it("flags a total built from other criteria or weights, without refusing to compare it", () => {
    const base = rubric([numeric("q"), numeric("r")]), head = rubric([numeric("q"), numeric("r", 10, { weight: 3 })]);
    const seen = { base: side([crit("q", 5), crit("r", 5)], 50), head: side([crit("q", 5), crit("r", 5)], 50) };
    expect(verifyExpectation({ base, head }, exp({ type: "hold" }), seen)).toMatchObject({ status: "met", caveat: "the two totals are built from different criteria or weights" });
    expect(verifyExpectation({ base, head: base }, exp({ type: "hold" }), seen)).not.toHaveProperty("caveat");
  });

  it("matches criteria by id or an explicit mapping, never by name", () => {
    const base = rubric([{ ...numeric("customers"), name: "Customer validation" }, numeric("team")]);
    const renamed = rubric([{ ...numeric("customer_validation"), name: "Customer validation" }, numeric("team"), numeric("market")]);
    const seen = { base: side([crit("customers", 10), crit("team", 4)]), head: side([crit("customer_validation", 6), crit("team", 4), crit("market", 3)]) };
    const drop = exp({ type: "decrease", criterion: "customer_validation", by: 4 });
    expect(counterpart(base, renamed, undefined, "customer_validation")).toEqual({ kind: "unconfirmed", candidates: ["customers"] });
    expect(verifyExpectation({ base, head: renamed }, drop, seen)).toMatchObject({ status: "needs_review", code: "mapping_unconfirmed", message: expect.stringContaining("customers has the same name") });
    expect(verifyExpectation({ base, head: renamed, mapping: { customer_validation: "customers" } }, drop, seen)).toMatchObject({ status: "met", observed: { base: 10, head: 6, delta: -4 } });
    expect(verifyExpectation({ base, head: renamed, mapping: { customer_validation: null } }, drop, seen)).toMatchObject({ status: "incomparable", code: "no_baseline_counterpart" });
    // A criterion that is simply new has no baseline; one written against the old id is gone, or renamed.
    expect(verifyExpectation({ base, head: renamed }, exp({ type: "hold", criterion: "market" }), seen)).toMatchObject({ status: "incomparable", code: "no_baseline_counterpart" });
    expect(verifyExpectation({ base, head: renamed }, exp({ type: "range", criterion: "market", min: 3, max: 3 }), seen).status).toBe("met");
    expect(verifyExpectation({ base, head: renamed }, exp({ type: "hold", criterion: "customers" }), seen)).toMatchObject({ status: "needs_review", message: expect.stringContaining("customer_validation has the same name") });
    const removed = rubric([numeric("team")]);
    expect(verifyExpectation({ base, head: removed }, exp({ type: "state", criterion: "customers", state: "scored" }), { base: seen.base, head: side([crit("team", 4)]) })).toMatchObject({ status: "incomparable", code: "criterion_removed" });
  });

  it("checks that the named facts are asked for with the rubric's own question, and leaves other wording to a person", () => {
    const head = rubric([{ ...numeric("q"), choices: { yes: "y", open: "o" }, values: { yes: 10 }, unresolved: { open: { state: "needs_info", requests: [{ field: "paid", question: "How many pay?" }, { field: "since", question: "Since when?" }] } } }]);
    const asks = (fields: string[], observed: CriterionObservation) => verifyExpectation({ base: one, head }, exp({ type: "asks_for", criterion: "q", fields }), { base: side([crit("q", 10)]), head: side([observed]) });
    const open = (requests: Array<{ field: string; question: string }>) => crit("q", null, { requests });
    expect(asks(["paid"], open([{ field: "paid", question: "How many pay?" }]))).toMatchObject({ status: "met", code: "asked", message: expect.stringContaining("paid: “How many pay?”"), observed: { state: "needs_info", head: null, fields: ["paid"] } });
    expect(asks(["paid", "since"], open([{ field: "paid", question: "How many pay?" }]))).toMatchObject({ status: "unmet", code: "field_not_requested", message: "q asks for paid; expected since as well" });
    expect(asks(["paid"], open([{ field: "paid", question: "Tell us about your customers." }]))).toMatchObject({ status: "needs_review", code: "question_unverified" });
    expect(asks(["paid"], crit("q", 0))).toMatchObject({ status: "unmet", code: "not_asked", message: "q scored 0 and asks nothing; expected a request for paid" });
    expect(asks(["paid"], crit("q", null, { state: "abstained", reason: "handed to a person" }))).toMatchObject({ status: "unmet", code: "not_asked", message: expect.stringContaining("q is abstained") });
  });

  it("turns a failed, cancelled or invalid evaluation into nothing to compare, never into a score", () => {
    const ok = side([crit("q", 10)]);
    const run = (raw: Record<string, unknown>, base: SideObservation, head: SideObservation) => verifyExpectation(ctx, exp({ criterion: "q", ...raw }), { base, head });
    expect(run({ type: "hold" }, ok, failed("failed"))).toMatchObject({ status: "incomparable", code: "candidate_failed", message: "the candidate evaluation failed: HTTP 503" });
    expect(run({ type: "state", state: "scored" }, ok, failed("cancelled"))).toMatchObject({ status: "incomparable", code: "candidate_cancelled" });
    expect(run({ type: "hold" }, ok, failed("invalid_output"))).toMatchObject({ status: "incomparable", code: "candidate_invalid_output", message: expect.stringContaining("yet a score of 0 is stored") });
    expect(run({ type: "hold" }, failed("failed"), ok)).toMatchObject({ status: "incomparable", code: "baseline_failed" });
    // The baseline failing does not stop what reads the candidate alone.
    expect(run({ type: "range", min: 10, max: 10 }, failed("failed"), ok).status).toBe("met");
    expect(run({ type: "hold" }, ok, side([crit("q", null, { execution: "error", state: null, error: "invalid decision choice" })]))).toMatchObject({ status: "incomparable", code: "criterion_error" });
  });
});

describe("a case and the summary", () => {
  const seen = { base: side([crit("q", 10)]), head: side([crit("q", 6)]) };
  const expectations = (list: Array<Record<string, unknown>>) => parseExpectations({ c: list }).c!;

  it("is met only when every expectation is; the worst result decides, and none at all is unverified", () => {
    expect(verifyCase(ctx, [], seen)).toEqual({ status: "unverified", expectations: [] });
    expect(verifyCase(ctx, expectations([{ type: "decrease", criterion: "q", by: 4 }, { type: "range", criterion: "q", min: 6, max: 6 }]), seen).status).toBe("met");
    const mixed = verifyCase(ctx, expectations([{ type: "decrease", criterion: "q", by: 4 }, { type: "range", criterion: "q", min: 7, max: 8 }]), seen);
    expect(mixed.status).toBe("unmet");
    expect(mixed.expectations.map((e) => [e.expectationId, e.status])).toEqual([["e1", "met"], ["e2", "unmet"]]);
    // One comparable expectation met and one with nothing to compare: the case is not a pass.
    const open = { base: seen.base, head: side([crit("q", null)]) };
    const partly = verifyCase(ctx, expectations([{ type: "state", criterion: "q", state: "needs_info" }, { type: "decrease", criterion: "q" }]), open);
    expect(partly.expectations.map((e) => e.status)).toEqual(["met", "incomparable"]);
    expect(partly.status).toBe("incomparable");
  });

  it("assigns ids, fills the stated defaults and rejects what cannot be checked", () => {
    expect(expectations([{ type: "hold" }, { type: "increase", criterion: "q" }, { id: "mine", type: "decrease" }])).toEqual([
      { id: "e1", type: "hold", tolerance: 0 }, { id: "e2", type: "increase", criterion: "q", by: 0 }, { id: "mine", type: "decrease", by: 0 },
    ]);
    expect(() => parseExpectations({ c: [{ type: "asks_for", fields: ["x"] }] })).toThrow(/case c, expectation 1: criterion/);
    expect(() => parseExpectations({ c: [{ type: "hold", tolerance: -1 }] })).toThrow(/tolerance/);
    expect(() => parseExpectations({ c: [{ type: "better" }] })).toThrow(/case c, expectation 1/);
  });

  it("keeps execution, judgment and verification as three tallies, with the verifiable cases as the rate's denominator", () => {
    const cases = [
      { seen, verification: verifyCase(ctx, expectations([{ type: "decrease", criterion: "q" }]), seen) },
      { seen, verification: verifyCase(ctx, expectations([{ type: "hold", criterion: "q" }]), seen) },
      { seen, verification: verifyCase(ctx, [], seen) },
      { seen: { base: seen.base, head: side([crit("q", null)]) }, verification: verifyCase(ctx, expectations([{ type: "state", criterion: "q", state: "needs_info" }]), { base: seen.base, head: side([crit("q", null)]) }) },
      { seen: { base: seen.base, head: failed("failed") }, verification: verifyCase(ctx, expectations([{ type: "hold", criterion: "q" }]), { base: seen.base, head: failed("failed") }) },
      { seen: { base: seen.base, head: failed("cancelled") }, verification: verifyCase(ctx, [], { base: seen.base, head: failed("cancelled") }) },
    ];
    expect(summarize(cases)).toEqual({
      cases: 6,
      execution: { evaluated: 4, failed: 1, unfinished: 1 },
      judgment: { scored: 3, needs_info: 1, abstained: 0, none: 2, newlyNeedsInfo: 1 },
      verification: { met: 2, unmet: 1, needs_review: 0, incomparable: 1, unverified: 2, verifiable: 3 },
      expectations: { total: 4, met: 2, unmet: 1, needs_review: 0, incomparable: 1 },
    });
  });
});

describe("what changed between two versions", () => {
  it("separates what a judge reads from how an answer is scored, criterion by criterion", () => {
    const options = { yes: "three or more customers", no: "fewer" };
    const base = rubric([{ ...numeric("q"), choices: options, values: { yes: 10, no: 0 } }, numeric("old")]);
    const head = rubric([{ ...numeric("q", 20), description: "count paying customers only", choices: { ...options, open: "cannot tell" }, values: { yes: 20, no: 0 }, weight: 2, unresolved: { open: { state: "abstain" } } }, numeric("fresh")], { context: "new context" });
    const changes = rubricChanges(base, head);
    expect(changes.map((c) => [c.layer, c.kind, c.criterionId ?? ""])).toEqual([
      ["judgment", "wording", "q"], ["judgment", "options", "q"], ["policy", "scoring", "q"], ["policy", "scale", "q"], ["policy", "weight", "q"], ["policy", "open_options", "q"],
      ["structure", "criterion_added", "fresh"], ["structure", "criterion_removed", "old"], ["judgment", "context", ""],
    ]);
    expect(changes.find((c) => c.kind === "scoring")).toMatchObject({ before: "yes: 10\nno: 0", after: "yes: 20\nno: 0" });
    expect(rubricChanges(base, base)).toEqual([]);
  });
});
