import { describe, expect, it } from "vitest";
import { Engine } from "@verdict/core";
import { watchState, watchPage } from "../src/watch.js";

const rubric = { name: "Keywords", criteria: [
  { id: "a", name: "Mentions alpha", judge: { type: "benchmark", method: "keywords", keywords: ["alpha"] } },
  { id: "b", name: "Mentions beta", judge: { type: "benchmark", method: "keywords", keywords: ["beta"] } },
] } as const;

describe("watchState", () => {
  it("is empty without evaluations", () => {
    expect(watchState([])).toMatchObject({ view: "empty", entries: [], running: 0 });
  });

  it("shows the latest evaluation with the previous one of the same rubric and the score history", async () => {
    const engine = new Engine();
    await engine.evaluate({ rubric, subject: { name: "draft", inputs: [{ type: "text", text: "gamma\nalpha" }] } });
    await new Promise((r) => setTimeout(r, 5));
    await engine.evaluate({ rubric, subject: { name: "draft", inputs: [{ type: "text", text: "gamma\nalpha beta" }] } });
    const s = watchState(await engine.store.listEvaluations());
    expect(s.view).toBe("single");
    expect(s.entries[0]!.evidence[0]!.text).toBe("gamma\nalpha beta");
    expect(s.previous!.evidence[0]!.text).toBe("gamma\nalpha");
    expect(s.history.map((h) => h.score)).toEqual([50, 100]);
    expect(s.entries[0]!.criteria.map((c) => c.normalized)).toEqual([1, 1]);
  });

  it("shows a batch as a leaderboard and re-ranks it after re-aggregation", async () => {
    const engine = new Engine();
    const { evaluations } = await engine.evaluateBatch({ ...rubric, criteria: [{ ...rubric.criteria[0], weight: 3 }, rubric.criteria[1]] }, [
      { name: "beta only", inputs: [{ type: "text", text: "beta" }] },
      { name: "alpha only", inputs: [{ type: "text", text: "alpha" }] },
    ]);
    let s = watchState(await engine.store.listEvaluations());
    expect(s.view).toBe("leaderboard");
    expect(s.entries.map((e) => e.name)).toEqual(["alpha only", "beta only"]);
    await new Promise((r) => setTimeout(r, 5));
    // Weight beta instead: same ratings, no judges called, new order.
    for (const ev of evaluations) await engine.reaggregate(ev.id, { method: "formula", formula: "b_n" });
    s = watchState(await engine.store.listEvaluations());
    expect(s.aggregation).toEqual({ method: "formula", formula: "b_n" });
    expect(s.entries.map((e) => e.name)).toEqual(["beta only", "alpha only"]);
  });

  it("keeps the last finished result while a new evaluation runs", async () => {
    const engine = new Engine();
    const done = await engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: "alpha" }] } });
    const running = { ...structuredClone(done), id: "eval_running", status: "running" as const, updatedAt: new Date(Date.now() + 1000).toISOString() };
    const s = watchState([done, running]);
    expect(s.entries[0]!.id).toBe(done.id);
    expect(s.running).toBe(1);
  });

  it("keeps the previous batch on screen until a new batch has finished", async () => {
    const engine = new Engine();
    const first = await engine.evaluateBatch(rubric, [{ name: "x", inputs: [{ type: "text", text: "alpha" }] }, { name: "y", inputs: [{ type: "text", text: "beta" }] }]);
    const second = await engine.evaluateBatch(rubric, [{ name: "x", inputs: [{ type: "text", text: "alpha beta" }] }, { name: "y", inputs: [{ type: "text", text: "beta" }] }]);
    const later = (e: (typeof second.evaluations)[number], ms: number, status = e.status) => ({ ...e, status, updatedAt: new Date(Date.now() + ms).toISOString() });
    const partial = [...first.evaluations, later(second.evaluations[0]!, 1000), later(second.evaluations[1]!, 1000, "running")];
    expect(new Set(watchState(partial).entries.map((e) => e.id))).toEqual(new Set(first.evaluations.map((e) => e.id)));
    const done = [...first.evaluations, later(second.evaluations[0]!, 1000), later(second.evaluations[1]!, 2000)];
    expect(new Set(watchState(done).entries.map((e) => e.id))).toEqual(new Set(second.evaluations.map((e) => e.id)));
  });

  it("surfaces failed gates", async () => {
    const engine = new Engine();
    await engine.evaluate({ rubric: { ...rubric, aggregation: { gates: [{ criterion: "b", min: 1, message: "beta is required" }] } }, subject: { inputs: [{ type: "text", text: "alpha" }] } });
    const s = watchState(await engine.store.listEvaluations());
    expect(s.entries[0]!.gatesFailed).toEqual(["beta is required"]);
    expect(s.entries[0]!.criteria.find((c) => c.id === "b")!.gateFailed).toBe("beta is required");
  });

  it("serves a self-contained page", () => {
    const html = watchPage("/tmp/x/.verdict");
    expect(html).toContain("/api/state");
    expect(html).not.toMatch(/<script src=|<link /);
  });
});
