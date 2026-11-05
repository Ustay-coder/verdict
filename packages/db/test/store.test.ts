import { describe, expect, it } from "vitest";
import { Engine } from "@verdict/core";
import { fromSqliteFile } from "../src/sqlite.js";
import { ratings } from "../src/schema/sqlite.js";

const rubric = {
  name: "db test",
  scale: { type: "numeric", min: 0, max: 9 }, // 10 integer levels, so mock level 7 → score 7
  defaultJudge: { type: "decision", provider: "mock", options: { level: 7 } },
  criteria: [
    { id: "a", name: "A" },
    { id: "b", name: "B", judge: { type: "benchmark", method: "keywords", keywords: ["x"] } },
    { id: "h", name: "H", judge: { type: "human", raters: ["alice"] } },
  ],
  aggregation: { grades: [{ label: "good", min: 50 }, { label: "bad", min: 0 }] },
};

describe("DrizzleStore on SQLite (same schema as D1)", () => {
  it("applies migrations idempotently and round-trips rubrics with tenant scoping", async () => {
    const { store, db } = await fromSqliteFile(":memory:");
    const { applyMigrations } = await import("../src/sqlite.js");
    await applyMigrations(db); // second run is a no-op
    const engine = new Engine({ store });
    const r = await engine.createRubric(rubric, "t1");
    expect((await store.getRubric(r.id, "t1"))?.name).toBe("db test");
    expect(await store.getRubric(r.id, "t2")).toBeUndefined();
    expect(await store.getRubric(r.id)).toBeDefined(); // unscoped read (admin)
    await engine.updateRubric(r.id, { ...rubric, name: "renamed" }, "t1");
    expect((await store.getRubric(r.id, "t1"))?.name).toBe("renamed");
    expect((await store.listRubrics({ tenantId: "t1" })).map((x) => x.id)).toEqual([r.id]);
    expect(await store.listRubrics({ tenantId: "t2" })).toEqual([]);
    expect(await store.deleteRubric(r.id, "t2")).toBe(false);
    expect(await store.deleteRubric(r.id, "t1")).toBe(true);
    expect(await store.getRubric(r.id)).toBeUndefined();
  });

  it("persists evaluations, indexed columns, denormalized ratings, and human submissions", async () => {
    const { store, db } = await fromSqliteFile(":memory:");
    const engine = new Engine({ store });
    const r = await engine.createRubric(rubric, "t1");
    const ev = await engine.evaluate({ rubric: r.id, tenantId: "t1", subject: { name: "S", inputs: [{ type: "text", text: "x marks the spot" }] } });
    expect(ev.status).toBe("pending_human");

    const stored = await store.getEvaluation(ev.id, "t1");
    expect(stored?.criteria.find((c) => c.criterionId === "a")?.score).toBe(7);
    expect(stored?.rubric.name).toBe("db test"); // frozen copy survives the rubric being edited later
    expect(await store.getEvaluation(ev.id, "t2")).toBeUndefined();

    let rows = await db.select().from(ratings);
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.criterionId === "a")?.judgeType).toBe("decision");
    expect(rows.find((x) => x.criterionId === "a")?.confidence).toBeGreaterThan(0);
    expect(rows.find((x) => x.criterionId === "h")?.status).toBe("pending");

    expect((await store.listEvaluations({ tenantId: "t1", status: "pending_human" })).map((e) => e.id)).toEqual([ev.id]);
    expect(await store.listEvaluations({ tenantId: "t1", status: "completed" })).toEqual([]);
    expect((await store.listEvaluations({ rubricId: r.id })).length).toBe(1);

    const done = await engine.submitScore(ev.id, { criterionId: "h", raterId: "alice", score: 9 }, "t1");
    expect(done.status).toBe("completed");
    rows = await db.select().from(ratings);
    expect(rows.find((x) => x.criterionId === "h")?.status).toBe("scored");
    expect(rows.find((x) => x.criterionId === "h")?.score).toBe(9);
    expect((await store.listEvaluations({ tenantId: "t1", status: "completed" })).length).toBe(1);
    const reloaded = await store.getEvaluation(ev.id);
    expect(reloaded?.aggregate.grade).toBe("good");

    const forRubric = await store.ratingsForRubric(r.id, "t1", ["decision", "human"]);
    expect(forRubric.map((x) => x.judgeType).sort()).toEqual(["decision", "human"]);
  });

  it("orders listings newest first and honours limit", async () => {
    const { store } = await fromSqliteFile(":memory:");
    const engine = new Engine({ store });
    const r = { name: "k", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["a"] } }] };
    for (const n of ["one", "two", "three"]) {
      await engine.evaluate({ rubric: r, subject: { name: n, inputs: [{ type: "text", text: "a" }] } });
      await new Promise((res) => setTimeout(res, 2));
    }
    const list = await store.listEvaluations({ limit: 2 });
    expect(list.map((e) => e.subject.name)).toEqual(["three", "two"]);
  });
});
