import { describe, expect, it } from "vitest";
import { Engine } from "@verdict-ai/core";
import { fromSqliteFile } from "../src/sqlite.js";
import { backends } from "./backends.js";
import { eq } from "drizzle-orm";

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

describe.each(backends)("DrizzleStore on $name", ({ open }) => {
  it("applies migrations idempotently and round-trips rubrics with tenant scoping", async () => {
    const { store, migrate } = await open();
    await migrate(); // second run is a no-op
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
  }, 30000);

  it("persists evaluations, indexed columns, denormalized ratings, and human submissions", async () => {
    const { store, db, tables: { ratings } } = await open();
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
    const { store } = await open();
    const engine = new Engine({ store });
    const r = { name: "k", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["a"] } }] };
    for (const n of ["one", "two", "three"]) {
      await engine.evaluate({ rubric: r, subject: { name: n, inputs: [{ type: "text", text: "a" }] } });
      await new Promise((res) => setTimeout(res, 2));
    }
    const list = await store.listEvaluations({ limit: 2 });
    expect(list.map((e) => e.subject.name)).toEqual(["three", "two"]);
  });

  it("round-trips and upserts idempotency records with exact tenant scoping", async () => {
    const { store } = await open();
    const record = { key: "retry", fingerprint: "abc", targetType: "evaluation" as const, targetId: "eval_1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    await store.putIdempotency(record);
    expect(await store.getIdempotency(undefined, "retry")).toEqual(record);
    expect(await store.getIdempotency("other", "retry")).toBeUndefined();
    const updated = { ...record, fingerprint: "def", targetType: "batch" as const, targetId: undefined, evaluationIds: ["eval_2", "eval_3"] };
    await store.putIdempotency(updated);
    expect(await store.getIdempotency(undefined, "retry")).toEqual(updated);
    const tenantRecord = { ...record, tenantId: "other" };
    await store.putIdempotency(tenantRecord);
    expect(await store.getIdempotency("other", "retry")).toEqual(tenantRecord);
    expect(await store.getIdempotency(undefined, "retry")).toEqual(updated);
  });


  it("replays concurrent requests and batches across store instances", async () => {
    const { store, db, tables } = await open();
    const { DrizzleStore, PgStore } = await import("../src/store.js");
    const { schema } = await import("../src/schema/sqlite.js");
    const other = tables === schema ? new DrizzleStore(db) : new PgStore(db as unknown as import("../src/dialects.js").PgDb);
    let starts = 0;
    const engines = [store, other].map(store => new Engine({ store, onEvent: e => { if (e.type === "evaluation.started") starts++; } }));
    const request = { rubric, subject: { inputs: [{ type: "text", text: "x" }] }, idempotencyKey: "concurrent", tenantId: "t1" };
    const results = await Promise.all(engines.map(e => e.evaluateIdempotent(request)));
    expect(results[0]!.evaluation.id).toBe(results[1]!.evaluation.id);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(starts).toBe(1);
    await db.delete(tables.evaluations).where(eq(tables.evaluations.id, results[0]!.evaluation.id));
    const next = await engines[1]!.evaluateIdempotent(request);
    expect(next.replayed).toBe(false);
    expect(next.evaluation.id).not.toBe(results[0]!.evaluation.id);
    const batch = await engines[0]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" });
    const replay = await engines[1]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" });
    expect(replay.replayed).toBe(true);
    expect(replay.ranking).toEqual(batch.ranking);
    await db.delete(tables.evaluations).where(eq(tables.evaluations.id, batch.evaluations[1]!.id));
    expect((await engines[1]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" })).replayed).toBe(false);
  });

  it("reserves once, recovers expired and deleted targets, and retains indexed values", async () => {
    const { store, db, tables } = await open();
    const engine = new Engine({ store });
    const e = await engine.evaluate({ rubric, tenantId: "t1", subject: { inputs: [{ type: "text", text: "x" }] } });
    const r = { tenantId: "t1", key: "reserve", fingerprint: "abc", targetType: "evaluation" as const, targetId: "reserved", createdAt: e.createdAt, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const initial = { ...e, id: r.targetId };
    expect(await store.reserveIdempotency(r, [initial])).toBe(true);
    expect(await store.reserveIdempotency(r, [initial])).toBe(false);
    const retry = { ...r, targetId: "retry" };
    expect(await store.reserveIdempotency(retry, [{ ...e, id: retry.targetId }])).toBe(false);
    await store.putIdempotency({ ...r, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await store.reserveIdempotency(retry, [{ ...e, id: retry.targetId }])).toBe(true);
    await db.delete(tables.evaluations).where(eq(tables.evaluations.id, retry.targetId));
    const recovered = { ...r, targetId: "recovered" };
    expect(await store.reserveIdempotency(recovered, [{ ...e, id: recovered.targetId }])).toBe(true);
    const batch = { ...r, key: "batch", targetType: "batch" as const, targetId: undefined, evaluationIds: ["b1", "b2"] };
    expect(await store.reserveIdempotency(batch, batch.evaluationIds.map(id => ({ ...e, id })))).toBe(true);
    expect(await store.reserveIdempotency({ ...batch, evaluationIds: ["c1", "c2"] }, [])).toBe(false);
    await db.delete(tables.evaluations).where(eq(tables.evaluations.id, "b2"));
    expect(await store.reserveIdempotency({ ...batch, evaluationIds: ["c1", "c2"] }, ["c1", "c2"].map(id => ({ ...e, id })))).toBe(true);
    const [row] = await db.select().from(tables.evaluations).where(eq(tables.evaluations.id, e.id));
    expect(row?.passed).toBe(e.aggregate.passed ?? null);
    expect(row?.score).toBe(e.aggregate.score ?? null);
  });
});

it("atomically reserves one run across independent database connections and recovers missing targets", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "verdict-db-idempotency-"));
  const first = await fromSqliteFile(join(dir, "test.sqlite"));
  const second = await fromSqliteFile(join(dir, "test.sqlite"));
  try {
    const request = { rubric, subject: { inputs: [{ type: "text", text: "x" }] }, idempotencyKey: "concurrent", tenantId: "t1" };
    let starts = 0;
    const engines = [first, second].map(h => new Engine({ store: h.store, onEvent: e => { if (e.type === "evaluation.started") starts++; } }));
    const results = await Promise.all(engines.map(e => e.evaluateIdempotent(request)));
    expect(results[0]!.evaluation.id).toBe(results[1]!.evaluation.id);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(starts).toBe(1);
    first.sqlite.prepare("delete from evaluations where id = ?").run(results[0]!.evaluation.id);
    const next = await engines[1]!.evaluateIdempotent(request);
    expect(next.replayed).toBe(false);
    expect(next.evaluation.id).not.toBe(results[0]!.evaluation.id);
    const batch = await engines[0]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" });
    const replay = await engines[1]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" });
    expect(replay.replayed).toBe(true);
    expect(replay.ranking).toEqual(batch.ranking);
    first.sqlite.prepare("delete from evaluations where id = ?").run(batch.evaluations[1]!.id);
    expect((await engines[1]!.evaluateBatchIdempotent(rubric, [request.subject, request.subject], { idempotencyKey: "batch", tenantId: "t1" })).replayed).toBe(false);
  } finally {
    first.sqlite.close(); second.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
