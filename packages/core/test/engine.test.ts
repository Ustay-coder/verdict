import { describe, expect, it } from "vitest";
import { Engine, ValidationError } from "../src/engine.js";
import { MemoryStore } from "../src/store/index.js";

const rubric = {
  name: "Pitch deck review",
  scale: { type: "numeric", min: 1, max: 5 },
  judges: { ai: { type: "llm", provider: "mock" } },
  defaultJudge: { type: "ref", ref: "ai" },
  criteria: [
    { id: "problem", name: "Problem clarity", weight: 2, judge: { type: "llm", provider: "mock", options: { score: 4 } } },
    { id: "traction", name: "Traction", weight: 2, judge: { type: "benchmark", method: "keywords", keywords: ["revenue", "users"], mode: "ratio" } },
    { id: "team", name: "Team", weight: 1, judge: { type: "human", raters: ["alice", "bob"], required: 2, instructions: "Rate founder-market fit." } },
    { id: "format", name: "Format", weight: 0.5, judge: { type: "panel", combine: "mean", judges: [{ type: "llm", provider: "mock", options: { score: 5 } }, { type: "benchmark", method: "length", unit: "words", min: 1, max: 500 }] } },
  ],
  aggregation: { passThreshold: 50, grades: [{ label: "strong", min: 80 }, { label: "ok", min: 50 }, { label: "weak", min: 0 }] },
};

describe("engine", () => {
  it("evaluates mixed judges, waits for humans, then completes and re-aggregates", async () => {
    const webhooks: unknown[] = [];
    const fetchMock: typeof fetch = async (_url, init) => { webhooks.push(JSON.parse(String(init?.body))); return new Response("ok"); };
    const engine = new Engine({ store: new MemoryStore(), fetch: fetchMock, webhookSecret: "s3cr3t" });
    const ev = await engine.evaluate({
      rubric,
      subject: { name: "Acme", inputs: [{ type: "text", text: "We have 10k users and growing revenue.", tags: ["deck"] }] },
      webhook: "https://example.com/hook",
    });
    expect(ev.status).toBe("pending_human");
    expect(ev.pendingTasks).toHaveLength(2);
    expect(ev.criteria.find((c) => c.criterionId === "problem")!.score).toBe(4);
    expect(ev.criteria.find((c) => c.criterionId === "traction")!.score).toBe(5);
    expect(ev.criteria.find((c) => c.criterionId === "format")!.score).toBe(5);
    expect(ev.aggregate.partial).toBe(true);
    expect(ev.aggregate.score).toBeDefined(); // provisional, excludes team
    expect(webhooks).toHaveLength(0);

    await expect(engine.submitScore(ev.id, { criterionId: "team", raterId: "mallory", score: 5 })).rejects.toThrow(/not allowed/);
    await expect(engine.submitScore(ev.id, { criterionId: "team", raterId: "alice", score: 3, confidence: NaN })).rejects.toBeInstanceOf(ValidationError);
    const after1 = await engine.submitScore(ev.id, { criterionId: "team", raterId: "alice", score: 3, rationale: "solid" });
    expect(after1.status).toBe("pending_human");
    await expect(engine.submitScore(ev.id, { criterionId: "team", raterId: "alice", score: 4 })).rejects.toThrow(/already scored/);
    const done = await engine.submitScore(ev.id, { criterionId: "team", raterId: "bob", score: 5 });
    expect(done.status).toBe("completed");
    const team = done.criteria.find((c) => c.criterionId === "team")!;
    expect(team.score).toBe(4);
    expect(done.aggregate.partial).toBe(false);
    // weighted mean of normalized (scale 1..5): problem .75*2, traction 1*2, team .75*1, format 1*.5 => (1.5+2+.75+.5)/5.5 = 0.8636
    expect(done.aggregate.score).toBeCloseTo(86.36, 1);
    expect(done.aggregate.grade).toBe("strong");
    expect(done.aggregate.passed).toBe(true);
    expect(webhooks).toHaveLength(1);

    const re = await engine.reaggregate(ev.id, { method: "min" }, undefined, false);
    expect(re.aggregate.score).toBeCloseTo(75);
    const formula = await engine.reaggregate(ev.id, { method: "formula", formula: "problem_n * 0.5 + team_n * 0.5" }, undefined, false);
    expect(formula.aggregate.score).toBeCloseTo(75);
    expect((await engine.store.getEvaluation(ev.id))!.aggregate.method).toBe("weighted_mean");
  });

  it("fails cleanly on ingestion errors and stores rubrics per tenant", async () => {
    const engine = new Engine();
    const stored = await engine.createRubric(rubric, "tenant_a");
    expect(await engine.store.getRubric(stored.id, "tenant_b")).toBeUndefined();
    const ev = await engine.evaluate({ rubric: stored.id, tenantId: "tenant_a", subject: { inputs: [{ type: "file", path: "/nope.pdf" }] } });
    expect(ev.status).toBe("failed");
    expect(ev.error).toMatch(/local file paths are disabled/);
  });

  it("ranks a batch", async () => {
    const engine = new Engine();
    const r = { name: "b", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["alpha", "beta"] } }] };
    const { ranking } = await engine.evaluateBatch(r, [
      { name: "none", inputs: [{ type: "text", text: "gamma" }] },
      { name: "both", inputs: [{ type: "text", text: "alpha beta" }] },
      { name: "one", inputs: [{ type: "text", text: "alpha" }] },
    ]);
    expect(ranking.map((x) => x.subject)).toEqual(["both", "one", "none"]);
    expect(ranking[0]!.rank).toBe(1);
  });

  it("rejects invalid rubrics with useful messages", async () => {
    const engine = new Engine();
    await expect(engine.createRubric({ name: "x", criteria: [{ id: "a", name: "a" }], aggregation: { gates: [{ criterion: "zzz" }] } })).rejects.toThrow(/unknown criterion: zzz/);
    await expect(engine.createRubric({ name: "x", criteria: [{ id: "a", name: "a", judge: { type: "ref", ref: "ghost" } }] })).rejects.toThrow(/unknown judge ref/);
    await expect(engine.createRubric({ name: "x", criteria: [{ id: "bad id", name: "a" }] })).rejects.toThrow();
  });
});

it("rejects empty criteria and ingested evidence before judging", async () => {
  const engine = new Engine({ fetch: async () => { throw new Error("must not call provider"); } });
  await expect(engine.evaluate({ rubric: { name: "empty", criteria: [] }, subject: { inputs: [{ type: "text", text: "content" }] } })).rejects.toBeInstanceOf(ValidationError);
  await expect(engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: "  " }] } })).rejects.toBeInstanceOf(ValidationError);
  expect((await engine.store.listEvaluations())[0]?.status).toBe("failed");
});

describe("batch ids", () => {
  it("gives every evaluation of a batch the same id, and a different one per batch, idempotent or not", async () => {
    const engine = new Engine();
    const rubric = { name: "B", criteria: [{ id: "a", name: "A", judge: { type: "benchmark" as const, method: "keywords" as const, keywords: ["x"] } }] };
    const subjects = [{ name: "one", inputs: [{ type: "text" as const, text: "x" }] }, { name: "two", inputs: [{ type: "text" as const, text: "y" }] }];
    const first = await engine.evaluateBatch(rubric, subjects);
    const second = await engine.evaluateBatchIdempotent(rubric, subjects, { idempotencyKey: "k" });
    const ids = (evs: Array<{ batchId?: string }>) => new Set(evs.map((e) => e.batchId));
    expect(ids(first.evaluations).size).toBe(1);
    expect([...ids(first.evaluations)][0]).toMatch(/^bat_/);
    expect(ids(second.evaluations).size).toBe(1);
    expect([...ids(second.evaluations)][0]).not.toBe([...ids(first.evaluations)][0]);
    expect((await engine.store.getEvaluation(second.evaluations[0]!.id))!.batchId).toBe(second.evaluations[0]!.batchId);
    expect((await engine.evaluate({ rubric, subject: subjects[0]! })).batchId).toBeUndefined();
  });
});
