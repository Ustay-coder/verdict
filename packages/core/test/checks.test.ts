import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { parseRubric } from "../src/schema/rubric.js";
const subject = { inputs: [{ type: "text", text: "a customer issue" }] };
const rubric = (action = "flag", extra = {}) => ({ name: "Checks", defaultJudge: { type: "decision", provider: "mock", options: { noul: 0.2 } }, criteria: [{ id: "quality", name: "Quality", judge: { type: "benchmark", method: "regex", pattern: "." } }], checks: [{ id: "topic", question: "On topic?", expect: true, action, message: "Off topic" }], ...extra });
it("batches several checks into one request before judging", async () => {
  let calls = 0;
  const engine = new Engine({ fetch: async (_url, init) => {
    calls++;
    expect(JSON.parse(String(init?.body)).questions).toEqual({ a: { type: "noul", instructions: "A?" }, b: { type: "noul", instructions: "B?" } });
    return Response.json({ answers: { a: { noul: 0.9 }, b: { noul: 0.8 } } });
  } });
  const ev = await engine.evaluate({ rubric: rubric("flag", { checksJudge: { type: "decision", provider: "typesafe" }, checks: [{ id: "a", question: "A?" }, { id: "b", question: "B?" }] }), subject });
  expect(calls).toBe(1);
  expect(ev.checks?.every(c => c.passed)).toBe(true);
  expect(ev.usage.decisionCalls).toBe(1);
});
it.each(["flag", "fail", "abort"])("implements %s and preserves it during reaggregation", async action => {
  const engine = new Engine();
  const ev = await engine.evaluate({ rubric: rubric(action), subject });
  expect(ev.status).toBe("completed");
  expect(ev.checks?.[0]).toMatchObject({ probability: 0.2, passed: false, action });
  if (action === "abort") {
    expect(ev.criteria[0]!.status).toBe("excluded");
    expect(ev.aggregate.score).toBeUndefined();
  } else expect(ev.aggregate.score).toBe(100);
  if (action === "fail") expect(ev.aggregate.gates).toContainEqual({ criterion: "check:topic", passed: false, message: "Off topic" });
  if (action !== "flag") expect(ev.aggregate.passed).toBe(false);
  const next = await engine.reaggregate(ev.id, { method: "mean" });
  expect(next.checks).toEqual(ev.checks);
  expect(next.aggregate.gates).toEqual(ev.aggregate.gates);
  if (action !== "flag") expect(next.aggregate.passed).toBe(false);
});
it("honors expect false and threshold boundaries", async () => {
  const ev = await new Engine().evaluate({ rubric: rubric("fail", { checks: [{ id: "a", question: "A?", expect: false, threshold: 0.3 }, { id: "b", question: "B?", expect: false, threshold: 0.2 }] }), subject });
  expect(ev.checks?.map(c => c.passed)).toEqual([true, false]);
});
it.each(["flag", "fail", "abort"])("handles provider errors with %s", async action => {
  const engine = new Engine({ fetch: async () => { throw new Error("offline"); } });
  const ev = await engine.evaluate({ rubric: rubric(action, { checksJudge: { type: "decision", provider: "typesafe" } }), subject });
  expect(ev.checks?.[0]).toMatchObject({ probability: null, passed: false, error: "offline" });
  expect(ev.status).toBe("completed");
  expect(ev.usage.decisionCalls).toBe(1);
  expect(ev.aggregate.gates).toEqual([]);
  if (action === "abort") { expect(ev.error).toBe("offline"); expect(ev.criteria[0]!.status).toBe("excluded"); }
  else expect(ev.aggregate.score).toBe(100);
});
it("requires a decision checks judge including references", () => {
  expect(() => parseRubric(rubric("flag", { checksJudge: { type: "human" } }))).toThrow(/decision/);
  expect(() => parseRubric(rubric("flag", { defaultJudge: { type: "human" } }))).toThrow(/decision/);
  expect(() => parseRubric(rubric("flag", { judges: { j: { type: "human" } }, checksJudge: { type: "ref", ref: "j" } }))).toThrow(/decision/);
});
