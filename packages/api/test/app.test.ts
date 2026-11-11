import { describe, expect, it } from "vitest";
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp } from "../src/app.js";

const rubricYaml = `
name: Grant application
scale: { type: numeric, min: 0, max: 5 }
criteria:
  - id: impact
    name: Impact
    judge: { type: llm, provider: mock, options: { score: 4 } }
  - id: budget
    name: Budget realism
    judge: { type: benchmark, method: keywords, keywords: [budget, cost] }
  - id: reviewer
    name: Reviewer opinion
    judge: { type: human, required: 1 }
aggregation: { passThreshold: 60 }
`;

function mk() {
  const engine = new Engine({ store: new MemoryStore() });
  const app = createApp({ engine, auth: { resolve: (k) => (k === "sk_test" ? "t1" : k === "sk_other" ? "t2" : undefined) } });
  const call = (path: string, init: RequestInit = {}, key = "sk_test") =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return { engine, app, call };
}

describe("api", () => {
  it("rejects bad keys and exposes health without auth", async () => {
    const { app, call } = mk();
    expect((await app.request("/v1/health")).status).toBe(200);
    expect((await call("/v1/rubrics", {}, "nope")).status).toBe(401);
  });

  it("creates a rubric from YAML, evaluates, submits a human score, re-aggregates", async () => {
    const { call } = mk();
    const created = await call("/v1/rubrics", { method: "POST", body: rubricYaml, headers: { "content-type": "application/yaml" } });
    expect(created.status).toBe(201);
    const rubric = await created.json();
    expect(rubric.id).toMatch(/^rub_/);

    // other tenant can't see it
    expect((await call(`/v1/rubrics/${rubric.id}`, {}, "sk_other")).status).toBe(404);

    const res = await call("/v1/evaluations", { method: "POST", body: JSON.stringify({ rubric: rubric.id, name: "Proposal A", inputs: [{ type: "text", text: "Our budget is lean; cost is low." }] }) });
    expect(res.status).toBe(201);
    const ev = await res.json();
    expect(ev.status).toBe("pending_human");
    expect(ev.evidence[0].text).toBeUndefined();
    expect(ev.evidence[0].chars).toBeGreaterThan(0);

    const tasks = await (await call("/v1/tasks")).json();
    expect(tasks.data).toHaveLength(1);
    expect(tasks.data[0].criterionId).toBe("reviewer");

    const bad = await call(`/v1/evaluations/${ev.id}/scores`, { method: "POST", body: JSON.stringify({ criterionId: "impact", raterId: "me", score: 3 }) });
    expect(bad.status).toBe(400);

    const scored = await call(`/v1/evaluations/${ev.id}/scores`, { method: "POST", body: JSON.stringify({ criterionId: "reviewer", raterId: "me", score: 5 }) });
    const done = await scored.json();
    expect(done.status).toBe("completed");
    // (0.8 + 1 + 1) / 3 = 93.33
    expect(done.aggregate.score).toBeCloseTo(93.33, 1);
    expect(done.aggregate.passed).toBe(true);

    const re = await call(`/v1/evaluations/${ev.id}/aggregate`, { method: "POST", body: JSON.stringify({ aggregation: { method: "min" } }) });
    expect((await re.json()).aggregate.score).toBeCloseTo(80);

    const full = await (await call(`/v1/evaluations/${ev.id}?evidence=true`)).json();
    expect(full.evidence[0].text).toContain("budget");
  });

  it("validates rubrics and reports errors as 400", async () => {
    const { call } = mk();
    const v = await (await call("/v1/rubrics/validate", { method: "POST", body: JSON.stringify({ name: "x", criteria: [] }) })).json();
    expect(v.valid).toBe(false);
    const r = await call("/v1/evaluations", { method: "POST", body: JSON.stringify({ rubric: "rub_missing", inputs: [{ type: "text", text: "x" }] }) });
    expect(r.status).toBe(404);
    const r2 = await call("/v1/evaluations", { method: "POST", body: JSON.stringify({ rubric: { name: "x", criteria: [{ id: "a", name: "a" }] } }) });
    expect(r2.status).toBe(400);
  });

  it("supports async evaluations", async () => {
    const { call } = mk();
    const res = await call("/v1/evaluations", { method: "POST", body: JSON.stringify({ async: true, rubric: { name: "kw", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["a"] } }] }, inputs: [{ type: "text", text: "a" }] }) });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    for (let i = 0; i < 50; i++) {
      const ev = await (await call(`/v1/evaluations/${id}`)).json();
      if (ev.status === "completed") { expect(ev.aggregate.score).toBe(100); return; }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("did not complete");
  });

  it("manages API keys through the admin routes when a database-backed key store is configured", async () => {
    const { fromSqliteFile } = await import("@verdict-ai/db/sqlite");
    const h = await fromSqliteFile(":memory:");
    const engine = new Engine({ store: h.store });
    const app = createApp({ engine, auth: h.auth, keys: h.auth, adminKey: "admin_secret" });
    expect((await app.request("/v1/admin/keys", { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: JSON.stringify({ tenantId: "acme", name: "ci" }) })).status).toBe(401);
    const created = await app.request("/v1/admin/keys", { method: "POST", headers: { authorization: "Bearer admin_secret", "content-type": "application/json" }, body: JSON.stringify({ tenantId: "acme", name: "ci" }) });
    expect(created.status).toBe(201);
    const { key, id } = await created.json();
    const r = await app.request("/v1/rubrics", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x", criteria: [{ id: "a", name: "a", judge: { type: "benchmark", method: "keywords", keywords: ["a"] } }] }) });
    expect(r.status).toBe(201);
    expect((await r.json()).tenantId).toBe("acme");
    expect((await app.request("/v1/admin/keys?tenant=acme", { headers: { authorization: "Bearer admin_secret" } })).status).toBe(200);
    expect((await app.request(`/v1/admin/keys/${id}`, { method: "DELETE", headers: { authorization: "Bearer admin_secret" } })).status).toBe(204);
    expect((await app.request("/v1/rubrics", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await app.request("/v1/rubrics", { headers: { authorization: "Bearer not_a_key" } })).status).toBe(401);
    // no admin key configured → admin routes 404
    const noAdmin = createApp({ engine, auth: h.auth, keys: h.auth, adminKey: undefined });
    expect((await noAdmin.request("/v1/admin/keys", { headers: { authorization: "Bearer x" } })).status).toBe(404);
  });

  it("returns tenant-scoped calibration reports and validates query options", async () => {
    const { engine, call } = mk();
    const rubric = await engine.createRubric({ name: "Calibration", scale: { type: "numeric", min: 0, max: 1 },
      criteria: [{ id: "q", name: "Q", judge: { type: "decision", provider: "mock", options: { probabilities: [0.5, 0.5] },
        minConfidence: 1, onLowConfidence: "human" }, levels: [{ value: 0, description: "bad" }, { value: 1, description: "good" }] }] }, "t1");
    const ev = await engine.evaluate({ rubric: rubric.id, tenantId: "t1", subject: { inputs: [{ type: "text", text: "test" }] } });
    await engine.submitScore(ev.id, { criterionId: "q", raterId: "me", score: 1 }, "t1");
    const response = await call(`/v1/rubrics/${rubric.id}/calibration?target=0.8&buckets=2&limit=1000`);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.overall.n).toBe(1);
    expect(report.overall.evaluations).toBe(1);
    expect(report.criteria[0].criterionId).toBe("q");
    expect(report.overall.buckets).toHaveLength(2);
    expect((await call("/v1/rubrics/missing/calibration")).status).toBe(404);
    expect((await call(`/v1/rubrics/${rubric.id}/calibration`, {}, "sk_other")).status).toBe(404);
    for (const query of ["buckets=0", "target=2", "limit=-1", "buckets=1.5", "target=nope"])
      expect((await call(`/v1/rubrics/${rubric.id}/calibration?${query}`)).status).toBe(400);
  });

  it("ranks batches", async () => {
    const { call } = mk();
    const res = await call("/v1/batches", { method: "POST", body: JSON.stringify({
      rubric: { name: "kw", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["a", "b"] } }] },
      subjects: [{ name: "low", inputs: [{ type: "text", text: "zzz" }] }, { name: "high", inputs: [{ type: "text", text: "a b" }] }],
    }) });
    const body = await res.json();
    expect(body.ranking[0].subject).toBe("high");
  });
});

it("presents choice fields and pre-screen abort results", async () => {
  const { call } = mk();
  const rubric = {
    name: "Routing", defaultJudge: { type: "decision", provider: "mock", options: { choice: "engineering", noul: 0.9 } },
    criteria: [{ id: "team", name: "Team", choices: { support: "Help", engineering: "Bugs" } }],
    checks: [{ id: "topic", question: "Real ticket?", action: "abort" }],
  };
  const evaluate = async (noul: number) => {
    const res = await call("/v1/evaluations", { method: "POST", body: JSON.stringify({ rubric: { ...rubric, defaultJudge: { ...rubric.defaultJudge, options: { choice: "engineering", noul } } }, inputs: [{ type: "text", text: "Bugs" }] }) });
    expect(res.status).toBe(201);
    return res.json();
  };
  const good = await evaluate(0.9);
  expect(good.criteria[0]).toMatchObject({ choice: "engineering", choices: { engineering: 1 }, ratings: [expect.objectContaining({ choice: "engineering" })] });
  const aborted = await evaluate(0.1);
  expect(aborted).toMatchObject({ status: "completed", checks: [{ id: "topic", probability: 0.1, passed: false, action: "abort" }], criteria: [{ status: "excluded", ratings: [] }], aggregate: { passed: false }, usage: { decisionCalls: 1 } });
  expect(aborted.aggregate.score).toBeUndefined();
});

const idempotentBody = { rubric: { name: "Retry", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] }, inputs: [{ type: "text", text: "hello" }] };

it("replays evaluation requests, ignores response flags, and exposes the key", async () => {
  const { call } = mk();
  const post = (body: unknown) => call("/v1/evaluations", { method: "POST", headers: { "idempotency-key": "retry" }, body: JSON.stringify(body) });
  const first = await post(idempotentBody);
  expect(first.status).toBe(201);
  const evaluation = await first.json();
  const second = await post({ ...idempotentBody, includeEvidence: true });
  expect(second.status).toBe(200);
  expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await second.json()).id).toBe(evaluation.id);
  expect((await (await call(`/v1/evaluations/${evaluation.id}`)).json()).idempotencyKey).toBe("retry");
  const conflict = await post({ ...idempotentBody, metadata: { changed: true } });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.type).toBe("idempotency_conflict");
});

it("rejects empty and over-long idempotency keys", async () => {
  const { call } = mk();
  for (const key of ["", "a".repeat(256)]) {
    expect((await call("/v1/evaluations", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(idempotentBody) })).status).toBe(400);
    expect((await call("/v1/batches", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ rubric: idempotentBody.rubric, subjects: [{ inputs: idempotentBody.inputs }] }) })).status).toBe(400);
  }
});

it("replays batches and conflicts on changed batch bodies", async () => {
  const { call } = mk();
  const body = { rubric: idempotentBody.rubric, subjects: [{ name: "one", inputs: idempotentBody.inputs }, { name: "two", inputs: idempotentBody.inputs }] };
  const post = (value: unknown) => call("/v1/batches", { method: "POST", headers: { "Idempotency-Key": "batch" }, body: JSON.stringify(value) });
  const first = await post(body);
  expect(first.status).toBe(201);
  const original = await first.json();
  const second = await post(body);
  expect(second.status).toBe(200);
  expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await second.json()).toEqual(original);
  expect((await post({ ...body, metadata: { changed: true } })).status).toBe(409);
});

it("returns stored summaries for async replays and propagates conflicts", async () => {
  const { call } = mk();
  const post = (body: unknown) => call("/v1/evaluations", { method: "POST", headers: { "Idempotency-Key": "async" }, body: JSON.stringify(body) });
  const first = await post({ ...idempotentBody, async: true });
  expect(first.status).toBe(202);
  const initial = await first.json();
  const replay = await post({ ...idempotentBody, async: true });
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toMatchObject({ id: initial.id, url: initial.url });
  expect((await post({ ...idempotentBody, async: true, name: "different" })).status).toBe(409);
});

it("queues async requests, exposes job and retries failed evaluations", async () => {
  const { MemoryQueue } = await import("@verdict-ai/core");
  const queue = new MemoryQueue();
  const engine = new Engine({ queue }); queue.engine = engine;
  const app = createApp({ engine });
  const body = { async: true, rubric: { name: "Queue", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] }, inputs: [{ type: "text", text: "hello" }] };
  const res = await app.request("/v1/evaluations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(202);
  const ref = await res.json();
  await queue.drain();
  expect(await (await app.request(ref.url)).json()).toMatchObject({ status: "completed", job: { attempts: 1 } });
  expect((await app.request("/v1/evaluations/missing/retry", { method: "POST" })).status).toBe(404);
  expect((await app.request(ref.url + "/retry", { method: "POST" })).status).toBe(409);
  const ev = (await engine.store.getEvaluation(ref.id, "default"))!;
  ev.status = "failed"; await engine.store.putEvaluation(ev);
  expect((await app.request(ref.url + "/retry", { method: "POST" })).status).toBe(202);
  await queue.drain();
});

it("registers async work with the background hook", async () => {
  const promises: Promise<unknown>[] = [];
  const app = createApp({ engine: new Engine(), background: promise => { promises.push(promise); } });
  const res = await app.request("/v1/evaluations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ async: true, rubric: { name: "Background", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] }, inputs: [{ type: "text", text: "hello" }] }) });
  expect(res.status).toBe(202);
  const ref = await res.json();
  await Promise.all(promises);
  expect(promises).toHaveLength(1);
  expect(await (await app.request(ref.url)).json()).toMatchObject({ status: "completed" });
});

it("returns a failed evaluation with inputErrors when inputs break the rubric's inputSchema", async () => {
  const app = createApp({ engine: new Engine({ store: new MemoryStore() }) });
  const rubric = { name: "Intent", inputSchema: { type: "object", required: ["utterance"] }, defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A", scale: { type: "binary" } }] };
  const res = await app.request("/v1/evaluations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rubric, inputs: [{ type: "json", data: { text: "hi" } }] }) });
  const body = await res.json() as { status: string; error: string; inputErrors: unknown[]; usage: { decisionCalls: number } };
  expect(body).toMatchObject({ status: "failed", error: "invalid input: $.utterance is required", inputErrors: [{ input: 0, path: "$.utterance", message: "is required" }], usage: { decisionCalls: 0 } });
});
