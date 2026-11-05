import { describe, expect, it } from "vitest";
import { Engine, MemoryStore } from "@verdict/core";
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
    const { fromSqliteFile } = await import("@verdict/db/sqlite");
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
