import { expect, it } from "vitest";
import { Engine, ProviderError, ingest } from "../src/index.js";
import { parseProvider, SystemOneResponseSchema } from "../src/provider-error.js";

const rubric = { name: "Deterministic", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] };

it("uses injected IDs and clock for replay and exact expiry", async () => {
  let now = Date.UTC(2030, 0, 1);
  let sequence = 0;
  const engine = new Engine({ now: () => now, newId: prefix => `${prefix}_${++sequence}`, idempotencyTtlMs: 100 });
  const req = { rubric, subject: { inputs: [{ type: "text", text: "hello" }] }, idempotencyKey: "stable" };
  const first = await engine.evaluateIdempotent(req);
  expect(first.evaluation.id).toBe("eval_1");
  expect(first.evaluation.createdAt).toBe("2030-01-01T00:00:00.000Z");
  now += 99;
  expect((await engine.evaluateIdempotent(req)).replayed).toBe(true);
  now += 1;
  const expired = await engine.evaluateIdempotent(req);
  expect(expired.replayed).toBe(false);
  expect(expired.evaluation.id).toBe("eval_3");
  expect(expired.evaluation.updatedAt).toBe("2030-01-01T00:00:00.100Z");
});

it("reads authorized local evidence through the injected reader", async () => {
  const readFile = async (path: string) => {
    expect(path).toBe("virtual.json");
    return new TextEncoder().encode('{"passed":true}');
  };
  const subject = { inputs: [{ type: "file" as const, path: "virtual.json" }] };
  const evidence = await ingest(subject, { allowLocalFiles: true, readFile });
  expect(evidence[0]!.json).toEqual({ passed: true });
  await expect(ingest(subject, { readFile })).rejects.toThrow("local file paths are disabled");
});

it("turns malformed provider answers into contextual error ratings", async () => {
  const payload = { answers: { a: { probabilities: "invalid" } } };
  expect(() => parseProvider("typesafe", SystemOneResponseSchema, payload)).toThrow(ProviderError);
  const engine = new Engine({ fetch: async () => Response.json(payload) });
  const ev = await engine.evaluate({ rubric: { ...rubric, defaultJudge: { type: "decision", provider: "typesafe" } }, subject: { inputs: [{ type: "text", text: "hello" }] } });
  expect(ev.criteria[0]!.ratings[0]).toMatchObject({ status: "error", error: expect.stringContaining("answers.a.probabilities") });
});

it("uses the reservation clock for FileStore expiry across engine instances", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileStore } = await import("../src/index.js");
  const dir = await mkdtemp(join(tmpdir(), "verdict-clock-"));
  let now = Date.UTC(2040, 0, 1);
  let sequence = 0;
  const options = { now: () => now, newId: (prefix: string) => `${prefix}_${++sequence}`, idempotencyTtlMs: 100 };
  const req = { rubric, subject: { inputs: [{ type: "text", text: "hello" }] }, idempotencyKey: "durable" };
  try {
    const first = await new Engine({ ...options, store: new FileStore(dir) }).evaluateIdempotent(req);
    now += 100;
    const second = await new Engine({ ...options, store: new FileStore(dir) }).evaluateIdempotent(req);
    expect(second.replayed).toBe(false);
    expect(second.evaluation.id).not.toBe(first.evaluation.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
