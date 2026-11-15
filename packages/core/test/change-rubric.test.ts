import { describe, expect, it } from "vitest";
import { Engine, freezeRubric, MemoryStore, parseRubric } from "../src/index.js";
import { buildSystemPrompt } from "../src/judges/llm/prompt.js";

const criterion = (extra: Record<string, unknown> = {}) => ({
  id: "customers", name: "Customers", scale: { type: "numeric", min: 0, max: 10 },
  choices: { enough: "three or more paying customers", few: "fewer than three customers", unknown: "the document does not say" },
  values: { enough: 10, few: 0 },
  unresolved: { unknown: { state: "needs_info", requests: [{ field: "paying_customers", question: "How many customers pay?" }] } },
  ...extra,
});
const rubric = (judge: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: "Customers", defaultJudge: judge, criteria: [criterion(extra)] });
const subject = (text: string) => ({ inputs: [{ type: "text", text }] });

describe("unresolved options in a rubric", () => {
  it("accepts an option without a value only when it is marked unresolved, and checks the marking", () => {
    expect(() => parseRubric(rubric({ type: "decision", provider: "mock" }))).not.toThrow();
    const bad = (extra: Record<string, unknown>) => () => parseRubric(rubric({ type: "decision", provider: "mock" }, extra));
    expect(bad({ unresolved: undefined })).toThrow(/values must cover every choice/);
    expect(bad({ values: { enough: 10, few: 0, unknown: 0 } })).toThrow(/unresolved option unknown must not have a value/);
    expect(bad({ unresolved: { nope: { state: "abstain" } } })).toThrow(/unresolved key nope not in choices/);
    expect(bad({ unresolved: { unknown: { state: "needs_info" } } })).toThrow(/needs at least one request/);
    expect(bad({ unresolved: { unknown: { state: "needs_info", requests: [{ field: "a", question: "?" }, { field: "a", question: "??" }] } } })).toThrow(/repeats a request field/);
    expect(bad({ choices: undefined, values: undefined })).toThrow(/unresolved requires choices/);
    expect(bad({ values: undefined, unresolved: { enough: { state: "abstain" }, few: { state: "abstain" }, unknown: { state: "abstain" } } })).toThrow(/at least one choice must be decidable/);
  });

  it("leaves the criterion and the total without a score — never zero — and says what to ask", async () => {
    const engine = new Engine({ store: new MemoryStore() });
    const ev = await engine.evaluate({ rubric: rubric({ type: "decision", provider: "mock", options: { choice: "unknown" } }), subject: subject("three customers") });
    expect(ev.status).toBe("completed");
    expect(ev.criteria[0]).toMatchObject({ status: "scored", choice: "unknown", unresolved: { state: "needs_info", option: "unknown", requests: [{ field: "paying_customers", question: "How many customers pay?" }] } });
    expect(ev.criteria[0]).not.toHaveProperty("score");
    expect(ev.criteria[0]).not.toHaveProperty("normalized");
    expect(ev.aggregate).toMatchObject({ partial: true, unresolved: ["customers"], excluded: ["customers"] });
    expect(ev.aggregate.score).toBeUndefined();
    const scored = await engine.evaluate({ rubric: rubric({ type: "decision", provider: "mock", options: { choice: "few" } }), subject: subject("one customer") });
    expect(scored.criteria[0]).toMatchObject({ score: 0, normalized: 0 });
    expect(scored.aggregate).toMatchObject({ partial: false, score: 0 });
    expect(scored.aggregate).not.toHaveProperty("unresolved");
  });

  it("applies the rubric's own missing policy to the provisional total, and keeps it marked provisional", async () => {
    const two = (missing: string) => ({ name: "Two", defaultJudge: { type: "decision", provider: "mock", options: { choice: "unknown", level: 4 } }, aggregation: { missing }, criteria: [criterion(), { id: "team", name: "Team", scale: { type: "numeric", min: 0, max: 4 } }] });
    const engine = new Engine({ store: new MemoryStore() });
    const excluded = await engine.evaluate({ rubric: two("exclude"), subject: subject("x") });
    expect(excluded.aggregate).toMatchObject({ partial: true, unresolved: ["customers"], included: ["team"] });
    const zero = await engine.evaluate({ rubric: two("zero"), subject: subject("x") });
    expect(zero.aggregate).toMatchObject({ partial: true, unresolved: ["customers"], included: ["customers", "team"] });
    expect(zero.aggregate.score).toBeCloseTo(excluded.aggregate.score! / 2, 1);
    expect(zero.criteria[0]).not.toHaveProperty("score");
  });

  it("an abstain option carries its reason and no request", async () => {
    const engine = new Engine({ store: new MemoryStore() });
    const r = rubric({ type: "decision", provider: "mock", options: { choice: "unknown" } }, { unresolved: { unknown: { state: "abstain", reason: "the two tables contradict each other" } } });
    const ev = await engine.evaluate({ rubric: r, subject: subject("x") });
    expect(ev.criteria[0]!.unresolved).toEqual({ state: "abstain", option: "unknown", reason: "the two tables contradict each other" });
  });

  it("counts what an open answer means as policy, and which options are undecidable as part of what is asked", async () => {
    const judge = { type: "decision", provider: "mock" };
    const base = await freezeRubric(rubric(judge));
    const otherQuestion = await freezeRubric(rubric(judge, { unresolved: { unknown: { state: "needs_info", requests: [{ field: "paying_customers", question: "How many of them pay?" }] } } }));
    expect(otherQuestion.judgmentHash).toBe(base.judgmentHash);
    expect(otherQuestion.policyHash).not.toBe(base.policyHash);
    const noOpen = await freezeRubric(rubric(judge, { unresolved: undefined, values: { enough: 10, few: 0, unknown: 0 } }));
    expect(noOpen.judgmentHash).not.toBe(base.judgmentHash);
  });

  it("tells an llm judge to pick the undecidable option instead of guessing, only where the rubric has one", () => {
    const parsed = parseRubric(rubric({ type: "llm", provider: "mock" }));
    const ctx = (c: (typeof parsed.criteria)[number]) => ({ rubric: parsed, criterion: c, scale: c.scale!, evidence: [], evaluationId: "e", env: () => undefined, fetch, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } });
    expect(buildSystemPrompt(ctx(parsed.criteria[0]!))).toContain("choose the option that says so. Never assume a fact the inputs do not state");
    expect(buildSystemPrompt(ctx({ ...parsed.criteria[0]!, unresolved: undefined }))).toContain("give the lowest reasonable score");
  });
});

describe("a script for the mock providers", () => {
  const script = [
    { when: "alpha", answers: { customers: { choose: ["missing_option", "enough"], rationale: "three contracts", quotes: ["alpha has three contracts"] } } },
    { when: ["beta", "down"], error: "scripted outage" },
    { when: "beta", answers: { customers: { choose: ["unknown"] } } },
  ];
  it("answers by the text judged, for a decision judge and for an llm judge with reason and quotes", async () => {
    const engine = new Engine({ store: new MemoryStore() });
    const decide = async (text: string) => (await engine.evaluate({ rubric: rubric({ type: "decision", provider: "mock", options: { script } }), subject: subject(text) })).criteria[0]!;
    expect(await decide("alpha has three contracts")).toMatchObject({ choice: "enough", score: 10 });
    expect(await decide("beta says nothing")).toMatchObject({ choice: "unknown", unresolved: { state: "needs_info" } });
    const told = (await engine.evaluate({ rubric: rubric({ type: "llm", provider: "mock", options: { script } }), subject: subject("alpha has three contracts") })).criteria[0]!;
    expect(told).toMatchObject({ choice: "enough", score: 10 });
    expect(told.ratings[0]).toMatchObject({ rationale: "three contracts", quotes: ["alpha has three contracts"], raw: { provider: "mock", model: "mock" } });
  });

  it("fails the call when the rule says so, refuses an option the criterion lacks, and falls back without a rule", async () => {
    const engine = new Engine({ store: new MemoryStore() });
    const run = (text: string, s: unknown = script) => engine.evaluate({ rubric: rubric({ type: "decision", provider: "mock", options: { script: s } }), subject: subject(text) });
    const down = await run("beta is down");
    expect(down.status).toBe("failed");
    expect(down.criteria[0]!.ratings[0]!.error).toContain("scripted outage");
    const invalid = await run("gamma", [{ when: "gamma", answers: { customers: { choose: ["not_an_option"] } } }]);
    expect(invalid.criteria[0]!.ratings[0]).toMatchObject({ status: "error", error: "invalid decision choice" });
    expect((await run("delta")).criteria[0]!.status).toBe("scored");
    expect((await run("x", "not a list")).criteria[0]!.ratings[0]!.error).toMatch(/mock: decide: invalid/);
  });
});
