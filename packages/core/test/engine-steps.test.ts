import { expect, it, vi } from "vitest";
import { Engine, type EngineOptions } from "../src/engine.js";
import type { Queue } from "../src/queue.js";
import { MemoryStore } from "../src/store/index.js";
import { parseRubric } from "../src/schema/rubric.js";
import type { Evaluation } from "../src/schema/evaluation.js";
import { initialEvaluation } from "../src/engine/shared.js";
import { ratingBase } from "../src/judges/types.js";

const rubric = parseRubric({ name: "Steps", defaultJudge: { type: "human" }, criteria: [{ id: "a", name: "A" }] });
const subject = { inputs: [{ type: "text" as const, text: "evidence" }] };
class Steps extends Engine {
  judges() { return this.judgesFor(rubric, rubric.criteria[0]!); }
  prepare(evaluation: Evaluation) { return this.prepareQueued(evaluation); }
  reserve(request: Parameters<Engine["evaluateIdempotent"]>[0]) { return this.runIdempotent(request, "evaluation", [request.subject]); }
  panels(evaluation: Evaluation) { this.recomputePanels(evaluation, evaluation.criteria[0]!); }
}

it("run builds judges through its injected factory and records missing single ratings", async () => {
  const factory: NonNullable<EngineOptions["judgeFactory"]> = vi.fn(() => ({ id: "empty", type: "human", expectedRatings: () => 1, rate: async () => [] }));
  const engine = new Steps({ judgeFactory: factory });
  expect(engine.judges()[0]!.id).toBe("empty");
  const evaluation = await engine.evaluate({ rubric, subject });
  expect(evaluation.status).toBe("failed");
  expect(evaluation.criteria[0]!.ratings[0]).toMatchObject({ status: "error", error: "judge returned no rating for criterion a" });
});

it("idempotent reservations use the supplied registry, store, clock and ids", async () => {
  const store = new MemoryStore();
  const locks: NonNullable<EngineOptions["locks"]> = new WeakMap();
  let sequence = 0;
  const engine = new Steps({ store, locks, now: () => 1000, newId: prefix => `${prefix}_${++sequence}` });
  const request = { rubric, subject, idempotencyKey: "same" };
  const first = await engine.reserve(request);
  const replay = await engine.reserve(request);
  expect(replay.evaluations[0]!.id).toBe(first.evaluations[0]!.id);
  expect(replay.replayed).toBe(true);
  expect(locks.get(store)?.reservations.size).toBe(0);
  expect((await store.getIdempotency(undefined, "same"))!.createdAt).toBe(new Date(1000).toISOString());
});

it("queued preparation uses the injected clock and retry policy without enqueuing", () => {
  const enqueue = vi.fn();
  const engine = new Steps({ now: () => 1234, retry: { maxAttempts: 3 }, queue: { enqueue } });
  const evaluation = initialEvaluation({ rubric, subject, id: "fixed" }, rubric, undefined, () => 0);
  expect(engine.prepare(evaluation)).toMatchObject({ status: "queued", job: { attempts: 0, maxAttempts: 3 }, updatedAt: new Date(1234).toISOString() });
  expect(enqueue).not.toHaveBeenCalled();
});

it("human panel recomputation preserves slots until every injected human finishes", async () => {
  const engine = new Steps({ now: () => 1234 });
  const evaluation = await engine.evaluate({ rubric, subject });
  const result = evaluation.criteria[0]!;
  const human = result.ratings[0]!;
  result.ratings.push({ ...human, id: "panel", judgeType: "panel", raw: { members: [human] }, status: "pending" });
  engine.panels(evaluation);
  expect(result.ratings).toHaveLength(2);
  human.status = "scored"; human.score = 3; human.normalized = 0.5;
  engine.panels(evaluation);
  expect(result.ratings).toHaveLength(1);
  expect(result.ratings[0]).toMatchObject({ id: "panel", status: "scored", normalized: 0.5 });
});

it("missing and empty batch answers produce one error per criterion without extra requests", async () => {
  const rateMany = vi.fn(async () => new Map([["a", []]]));
  const engine = new Engine({ judgeFactory: () => ({ id: "batch", type: "human", expectedRatings: () => 1, batchKey: () => "same", rateMany, rate: async ctx => [ratingBase(ctx, { id: "batch", type: "human" })] }) });
  const evaluation = await engine.evaluate({ rubric: { ...rubric, criteria: [...rubric.criteria, { ...rubric.criteria[0]!, id: "b" }] }, subject });
  expect(rateMany).toHaveBeenCalledOnce();
  expect(evaluation.criteria.map(c => c.ratings[0]!.status)).toEqual(["error", "error"]);
});

it("provider failures name their provider and operation once while checks keep the original diagnostic", async () => {
  const engine = new Engine({ fetch: async () => { throw new Error("offline"); } });
  const evaluation = await engine.evaluate({ rubric: { ...rubric, defaultJudge: { type: "decision", provider: "typesafe" } }, subject });
  expect(evaluation.criteria[0]!.ratings[0]!.error).toBe("typesafe: decide: offline");
});

it("shares in-flight jobs across engines through the injected store lock registry", async () => {
  const store = new MemoryStore();
  const locks: NonNullable<EngineOptions["locks"]> = new WeakMap();
  const enqueue = vi.fn<Queue["enqueue"]>(async () => {});
  const factory: NonNullable<EngineOptions["judgeFactory"]> = vi.fn(() => ({ id: "one", type: "human", expectedRatings: () => 1, rate: async () => [] }));
  const options = { store, locks, queue: { enqueue }, judgeFactory: factory };
  const first = new Engine(options), second = new Engine(options);
  await first.enqueueEvaluation({ rubric, subject });
  const job = enqueue.mock.calls[0]![0];
  const [left, right] = await Promise.all([first.processJob(job), second.processJob(job)]);
  expect(left).toBe(right);
  expect(factory).toHaveBeenCalledOnce();
  expect(locks.get(store)?.jobs.size).toBe(0);
});
