import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { parseRubric } from "../src/schema/rubric.js";
const choices = { support: "General help", engineering: "Bugs and outages", billing: "Invoices and payments" };
const criterion = { id: "team", name: "Team", choices };
const subject = { inputs: [{ type: "text", text: "Bugs and outages" }] };
const rubric = (extra = {}) => ({ name: "Routing", defaultJudge: { type: "decision", provider: "mock", options: { choice: "engineering" } }, criteria: [criterion], ...extra });
it("validates choice identifiers, levels, and value keys", () => {
  for (const c of [{ ...criterion, choices: { "bad-id": "bad", ok: "ok" } }, { ...criterion, levels: [{ value: 0, description: "a" }, { value: 1, description: "b" }] }, { ...criterion, values: { absent: 1 } }]) expect(() => parseRubric(rubric({ criteria: [c] }))).toThrow();
});
it("sends the documented System One choice shape and retains the answer", async () => {
  const engine = new Engine({ fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.questions.team).toMatchObject({ type: "choice", criteria: choices });
    return Response.json({ answers: { team: { type: "choice", choice: "engineering", confidence: 0.88, probabilities: { support: 0.04, engineering: 0.92, billing: 0.04 } } } });
  } });
  const ev = await engine.evaluate({ rubric: rubric({ defaultJudge: { type: "decision", provider: "typesafe" } }), subject });
  expect(ev.criteria[0]).toMatchObject({ choice: "engineering", choices: { engineering: 0.92 }, status: "scored", pending: 0 });
  expect(ev.aggregate.excluded).toEqual(["team"]);
  expect(ev.criteria[0]!.ratings[0]!.confidence).toBe(0.88);
});
it("maps values to score and exposes formula indicators and probabilities", async () => {
  const engine = new Engine();
  const mapped = await engine.evaluate({ rubric: rubric({ criteria: [{ ...criterion, values: { support: 0, engineering: 10, billing: 5 } }] }), subject });
  expect(mapped.aggregate.score).toBe(100);
  const ev = await engine.evaluate({ rubric: rubric({ aggregation: { method: "formula", formula: "team_engineering * team_p_engineering" } }), subject });
  expect(ev.aggregate.score).toBe(100);
});
it("accepts human option ids and breaks majority ties in declaration order", async () => {
  const engine = new Engine();
  const ev = await engine.evaluate({ rubric: rubric({ defaultJudge: { type: "human", required: 2 } }), subject });
  await expect(engine.submitScore(ev.id, { criterionId: "team", raterId: "a", score: "unknown" })).rejects.toThrow();
  await engine.submitScore(ev.id, { criterionId: "team", raterId: "a", score: "engineering" });
  const done = await engine.submitScore(ev.id, { criterionId: "team", raterId: "b", score: "support" });
  expect(done.criteria[0]).toMatchObject({ choice: "support", choices: { support: 0.5, engineering: 0.5 }, pending: 0 });
});
it("supports forced and word overlap mock choices", async () => {
  for (const [options, choice] of [[{ choice: "billing" }, "billing"], [{}, "engineering"]] as const) {
    const ev = await new Engine().evaluate({ rubric: rubric({ defaultJudge: { type: "decision", provider: "mock", options } }), subject });
    expect(ev.criteria[0]!.choice).toBe(choice);
  }
});
it("escalates low confidence choice answers", async () => {
  const engine = new Engine({ fetch: async () => Response.json({ answers: { team: { choice: "engineering", confidence: 0.2, probabilities: { support: 0.3, engineering: 0.4, billing: 0.3 } } } }) });
  const ev = await engine.evaluate({ rubric: rubric({ defaultJudge: { type: "decision", provider: "typesafe", minConfidence: 0.8, onLowConfidence: "human" } }), subject });
  expect(ev.status).toBe("pending_human");
  expect(ev.criteria[0]!.ratings[0]!.raw?.escalatedFrom).toMatchObject({ choice: "engineering" });
});
it("rejects benchmark choice ratings and supports llm choices", async () => {
  const bad = await new Engine().evaluate({ rubric: rubric({ defaultJudge: { type: "benchmark", method: "regex", pattern: "." } }), subject });
  expect(bad.criteria[0]!.ratings[0]!.error).toBe("benchmark judges cannot answer choice criteria");
  const good = await new Engine().evaluate({ rubric: rubric({ defaultJudge: { type: "llm", provider: "mock", options: { choice: "billing" } } }), subject });
  expect(good.criteria[0]!.choice).toBe("billing");
});
