import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import { MemoryQueue, type Job } from "../src/queue.js";

const rubric = { name: "Queue", defaultJudge: { type: "decision", provider: "typesafe" }, criteria: [{ id: "a", name: "A" }] };
const subject = { inputs: [{ type: "text", text: "hello" }] };

describe("queue", () => {
  for (const failures of [0, 2, Infinity]) it(`processes ${failures} transient failures with one terminal webhook`, async () => {
    let calls = 0;
    const hooks: { type: string }[] = [];
    const backoff = vi.fn(() => 1);
    const queue = new MemoryQueue({ concurrency: 1 });
    const engine = new Engine({ queue, retry: { maxAttempts: failures === Infinity ? 2 : 5, backoffMs: backoff }, fetch: async (url, init) => {
      if (String(url).includes("/hook")) { hooks.push(JSON.parse(String(init?.body))); return new Response("ok"); }
      calls++;
      return calls <= failures ? new Response("busy", { status: 429 }) : Response.json({ answers: { a: { score: 1 } } });
    } });
    queue.engine = engine;
    const ev = await engine.enqueueEvaluation({ rubric, subject, webhook: "https://example.com/hook" });
    expect(ev.status).toBe("queued");
    await queue.drain();
    const done = (await engine.store.getEvaluation(ev.id))!;
    expect(done.status).toBe(failures === Infinity ? "failed" : "completed");
    expect(done.job?.attempts).toBe(failures === Infinity ? 2 : failures + 1);
    expect(done.job?.deadLettered).toBe(failures === Infinity ? true : undefined);
    expect(hooks).toEqual([{ type: failures === Infinity ? "evaluation.failed" : "evaluation.completed", data: expect.anything() }]);
    if (failures) expect(backoff).toHaveBeenCalledWith(1);
    const job: Job = { type: "evaluate", evaluationId: ev.id, request: { rubric, subject }, attempt: 1 };
    await engine.processJob(job);
    expect(calls).toBe(failures === Infinity ? 2 : failures + 1);
    expect(hooks).toHaveLength(1);
  });

  it("does not retry non-transient ingestion failures", async () => {
    const queue = new MemoryQueue();
    const engine = new Engine({ queue }); queue.engine = engine;
    const ev = await engine.enqueueEvaluation({ rubric, subject: { inputs: [{ type: "file", path: "/disabled" }] } });
    await queue.drain();
    expect(await engine.store.getEvaluation(ev.id)).toMatchObject({ status: "failed", job: { attempts: 1 } });
  });

  it("reserves queued idempotent documents without duplicate enqueue", async () => {
    const enqueue = vi.fn(async () => {});
    const engine = new Engine({ queue: { enqueue } });
    const req = { rubric, subject, idempotencyKey: "same" };
    const first = await engine.enqueueEvaluationIdempotent(req);
    const replay = await engine.enqueueEvaluationIdempotent(req);
    expect(replay.replayed).toBe(true);
    expect(replay.evaluation).toEqual(first.evaluation);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

it("uses the configured backoff delay before the next attempt", async () => {
  vi.useFakeTimers();
  try {
    const queue = new MemoryQueue();
    let calls = 0;
    const backoffMs = vi.fn(() => 123);
    const engine = new Engine({ queue, retry: { backoffMs }, fetch: async () => {
      calls++;
      return calls === 1 ? new Response("busy", { status: 429 }) : Response.json({ answers: { a: { score: 1 } } });
    } });
    queue.engine = engine;
    const ev = await engine.enqueueEvaluation({ rubric, subject });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(backoffMs).toHaveBeenCalledWith(1);
    expect((await engine.store.getEvaluation(ev.id))?.job?.nextAttemptAt).toBe(new Date(Date.now() + 123).toISOString());
    await vi.advanceTimersByTimeAsync(122);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await queue.drain();
    expect(calls).toBe(2);
    expect((await engine.store.getEvaluation(ev.id))?.status).toBe("completed");
  } finally { vi.useRealTimers(); }
});

describe("a rate-limited provider and the two ways an evaluation runs", () => {
  const limitedOnce = () => { let calls = 0; const f: typeof fetch = async () => (++calls === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "3" } }) : Response.json({ answers: { a: { score: 1 } } })); return { f, calls: () => calls }; };

  it("waits and asks again inside a direct evaluation when the engine was given a way to wait", async () => {
    const waits: number[] = [], net = limitedOnce();
    const engine = new Engine({ fetch: net.f, env: () => "k", rateLimitWait: async (ms) => { waits.push(ms); } });
    const ev = await engine.evaluate({ rubric, subject });
    expect(ev.status).toBe("completed");
    expect(waits).toEqual([4000]);
    expect(net.calls()).toBe(2);
  });

  it("fails the case at once when the engine was given none", async () => {
    const net = limitedOnce();
    const ev = await new Engine({ fetch: net.f, env: () => "k" }).evaluate({ rubric, subject });
    expect(ev.status).toBe("failed");
    expect(net.calls()).toBe(1);
  });

  it("leaves a queued evaluation to its queue: the call does not wait, the job is retried", async () => {
    const waits: number[] = [], net = limitedOnce();
    const queue = new MemoryQueue({ concurrency: 1 });
    const engine = new Engine({ queue, fetch: net.f, env: () => "k", retry: { maxAttempts: 3, backoffMs: () => 1 }, rateLimitWait: async (ms) => { waits.push(ms); } });
    queue.engine = engine;
    const ev = await engine.enqueueEvaluation({ rubric, subject });
    await queue.drain();
    const done = (await engine.store.getEvaluation(ev.id))!;
    expect(done.status).toBe("completed");
    expect(done.job?.attempts).toBe(2);
    expect(waits).toEqual([]);
  });
});
