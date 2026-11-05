import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, fingerprint } from "../src/idempotency.js";
import { ConflictError, Engine, rankEvaluations } from "../src/engine.js";
import { FileStore, MemoryStore } from "../src/store/index.js";

const rubric = { name: "Idempotency", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] };
const subject = { inputs: [{ type: "text", text: "hello" }] };
const req = { rubric, subject, idempotencyKey: "retry" };

describe("idempotency", () => {
  it("canonicalizes nested objects, preserves array order, and hashes with SHA-256", async () => {
    const a = { z: [{ b: 2, a: 1 }, 3], a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, z: [{ a: 1, b: 2 }, 3] };
    expect(canonicalJson(a)).toBe('{"a":{"x":1,"y":2},"z":[{"a":1,"b":2},3]}');
    expect(await fingerprint(a)).toBe(await fingerprint(b));
    expect(await fingerprint([1, 2])).not.toBe(await fingerprint([2, 1]));
    expect(await fingerprint({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("replays the same evaluation without new decision calls", async () => {
    let starts = 0;
    const engine = new Engine({ onEvent: e => { if (e.type === "evaluation.started") starts++; } });
    const first = await engine.evaluateIdempotent(req);
    const second = await engine.evaluateIdempotent(req);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.evaluation.id).toBe(first.evaluation.id);
    expect(second.evaluation.idempotencyKey).toBe("retry");
    expect(first.evaluation.usage.decisionCalls).toBe(1);
    expect(second.evaluation.usage.decisionCalls).toBe(1);
    expect(starts).toBe(1);
    expect(await engine.store.listEvaluations()).toHaveLength(1);
  });

  it("conflicts on changed body and isolates tenants including the undefined tenant", async () => {
    const engine = new Engine();
    const first = await engine.evaluateIdempotent(req);
    await expect(engine.evaluateIdempotent({ ...req, metadata: { changed: true } })).rejects.toBeInstanceOf(ConflictError);
    const other = await engine.evaluateIdempotent({ ...req, tenantId: "other", metadata: { changed: true } });
    expect(other.replayed).toBe(false);
    expect(other.evaluation.id).not.toBe(first.evaluation.id);
    expect((await engine.evaluateIdempotent(req)).evaluation.id).toBe(first.evaluation.id);
  });

  it("overwrites expired keys", async () => {
    const engine = new Engine({ idempotencyTtlMs: 1 });
    const first = await engine.evaluateIdempotent(req);
    await new Promise(resolve => setTimeout(resolve, 5));
    const next = await engine.evaluateIdempotent(req);
    expect(next.replayed).toBe(false);
    expect(next.evaluation.id).not.toBe(first.evaluation.id);
  });

  it("treats a deleted target as absent even if the request changed", async () => {
    const store = new MemoryStore();
    const engine = new Engine({ store });
    const first = await engine.evaluateIdempotent(req);
    store.evaluations.delete(first.evaluation.id);
    const next = await engine.evaluateIdempotent({ ...req, metadata: { changed: true } });
    expect(next.replayed).toBe(false);
    expect(next.evaluation.id).not.toBe(first.evaluation.id);
  });

  it("rebuilds batch rankings from current stored evaluations without judging again", async () => {
    const store = new MemoryStore();
    const engine = new Engine({ store });
    const subjects = [{ ...subject, name: "one" }, { ...subject, name: "two" }];
    const first = await engine.evaluateBatchIdempotent(rubric, subjects, { idempotencyKey: "batch" });
    first.evaluations[1]!.aggregate.score = 999;
    await store.putEvaluation(first.evaluations[1]!);
    const second = await engine.evaluateBatchIdempotent(rubric, subjects, { idempotencyKey: "batch" });
    expect(second.replayed).toBe(true);
    expect(second.evaluations.map(e => e.id)).toEqual(first.evaluations.map(e => e.id));
    expect(second.ranking).toEqual(rankEvaluations(first.evaluations));
    expect(second.ranking[0]!.subject).toBe("two");
    expect(await store.listEvaluations()).toHaveLength(2);
    await expect(engine.evaluateBatchIdempotent(rubric, subjects, { idempotencyKey: "batch", metadata: { different: true } })).rejects.toBeInstanceOf(ConflictError);
  });

  it("serializes concurrent duplicate reservations across engines sharing a store", async () => {
    const store = new MemoryStore();
    const engine = new Engine({ store });
    const other = new Engine({ store });
    const results = await Promise.all([engine.evaluateIdempotent(req), other.evaluateIdempotent(req)]);
    expect(results[0]!.evaluation.id).toBe(results[1]!.evaluation.id);
    expect(results.map(r => r.replayed)).toEqual([false, true]);
    expect(await store.listEvaluations()).toHaveLength(1);
  });

  it("persists file keys across store instances and safely handles arbitrary keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-idempotency-"));
    try {
      const keyReq = { ...req, tenantId: "tenant", idempotencyKey: "../../unsafe/🔑" };
      const first = await new Engine({ store: new FileStore(dir) }).evaluateIdempotent(keyReq);
      const second = await new Engine({ store: new FileStore(dir) }).evaluateIdempotent(keyReq);
      expect(second.replayed).toBe(true);
      expect(second.evaluation.id).toBe(first.evaluation.id);
      expect(await new FileStore(dir).getIdempotency(undefined, keyReq.idempotencyKey)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it("reserves one evaluation across concurrent FileStore instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verdict-file-concurrent-"));
  try {
    const engines = [new FileStore(dir), new FileStore(dir)].map(store => new Engine({ store }));
    const results = await Promise.all(engines.map(engine => engine.evaluateIdempotent(req)));
    expect(results[0]!.evaluation.id).toBe(results[1]!.evaluation.id);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(await engines[0]!.store.listEvaluations()).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
