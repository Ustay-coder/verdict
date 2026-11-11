import { describe, expect, it } from "vitest";
import { comparisonReportRequest, Engine, MemoryStore, runReportRequest, type Authorize } from "@verdict-ai/core";
import { createApp, type AppOptions } from "../src/app.js";
import { localRuns, PRIVATE } from "./control-fixtures.js";

async function setup(options: Partial<AppOptions> = {}) {
  const store = new MemoryStore();
  const app = createApp({ engine: new Engine({ store }), auth: { resolve: (k) => (k === "sk_ci" ? { tenantId: "acme", actor: { kind: "key", id: "key_ci", name: "ci" } } : k === "sk_other" ? "other" : undefined) }, now: () => Date.parse("2026-11-10T00:00:00.000Z"), ...options });
  const sent: string[] = [];
  const call = async (method: string, path: string, body?: unknown, key = "sk_ci") => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text) sent.push(text);
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: text });
    return { status: res.status, body: await res.json() as any };
  };
  await call("POST", "/v1/projects", { name: "bot" });
  const local = await localRuns();
  const report = (side: "base" | "head", extras: { withVersion?: boolean; name?: string } = {}) => {
    const { run, report: agreement } = side === "base" ? local.baseRun : local.headRun;
    return runReportRequest(extras.name ?? "intent", run, agreement, {
      datasetName: local.dataset.name, source: { commit: "abc123", branch: "feature/x", url: "https://ci.example/runs/7" },
      ...(extras.withVersion === false ? {} : { version: local[side] }),
    });
  };
  return { call, store, sent, report, ...local };
}

describe("run reports", () => {
  it("keeps the numbers of a run and the version it came with, and nothing about its cases", async () => {
    const t = await setup();
    const created = await t.call("POST", "/v1/projects/bot/reports/runs", t.report("head"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      created: true,
      report: {
        project: "bot", name: "intent", datasetName: "cases.jsonl", reportedAt: "2026-11-10T00:00:00.000Z",
        source: { commit: "abc123", branch: "feature/x", url: "https://ci.example/runs/7" }, actor: { kind: "key", id: "key_ci", name: "ci" },
        usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
        summary: { runId: t.headRun.run.id, origin: "author_reported", rubricVersionId: t.head.id, status: "completed", counts: { cases: 3, completed: 3 }, agreement: { criteria: { wants: { n: 3, agreed: 3, askedHuman: 0 } } }, labelSources: { human: 2, unspecified: 1 } },
      },
    });
    expect(created.body.report).not.toHaveProperty("tenantId");
    expect(created.body.report.summary).not.toHaveProperty("casesPublic");
    // The version came with the report: a pull request's rubric is not on the server before CI runs.
    expect((await t.call("GET", `/v1/projects/bot/rubrics/intent/versions/${t.head.id}`)).status).toBe(200);
    // Reporting the same run again is a no-op that returns what is stored (CI retries).
    const again = await t.call("POST", "/v1/projects/bot/reports/runs", { ...t.report("head"), source: { commit: "other" } });
    expect(again).toMatchObject({ status: 200, body: { created: false, report: { source: { commit: "abc123" } } } });
    expect((await t.call("GET", `/v1/projects/bot/reports/runs/${t.headRun.run.id}`)).body.summary.runId).toBe(t.headRun.run.id);
    expect((await t.call("GET", "/v1/projects/bot/reports/runs/run_missing")).status).toBe(404);
    // Neither what was sent nor what is kept names a case, an evaluation or an input.
    const kept = [await t.store.control.listRunReports({ tenantId: "acme", project: "bot" }), await t.store.control.listVersions({ tenantId: "acme", project: "bot" })];
    for (const leak of PRIVATE) expect(JSON.stringify([t.sent, kept, created.body])).not.toContain(leak);
  });

  it("drops case rows a client sends anyway", async () => {
    const t = await setup();
    const request = t.report("base");
    const padded = { ...request, run: { ...request.run, cases: t.baseRun.run.cases }, report: { ...request.report, results: t.baseRun.report.results } };
    const stored = await t.call("POST", "/v1/projects/bot/reports/runs", padded);
    expect(stored.status).toBe(201);
    const kept = JSON.stringify([stored.body, await t.call("GET", `/v1/projects/bot/reports/runs/${t.baseRun.run.id}`)]);
    for (const leak of PRIVATE) expect(kept).not.toContain(leak);
  });

  it("accepts a run only of a version it holds, with that version's hashes", async () => {
    const t = await setup();
    const bare = t.report("base", { withVersion: false });
    expect(await t.call("POST", "/v1/projects/bot/reports/runs", bare)).toMatchObject({ status: 400, body: { error: { type: "unknown_version" } } });
    expect((await t.call("POST", "/v1/projects/nope/reports/runs", bare)).status).toBe(404);
    expect((await t.call("POST", "/v1/projects/nope/reports/runs", t.report("base"))).status).toBe(404);
    // The version sent along must be the run's version.
    const mismatched = await t.call("POST", "/v1/projects/bot/reports/runs", { ...bare, version: { id: t.head.id, rubric: t.head.rubric } });
    expect(mismatched).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining(`sends version ${t.head.id}`) } } });
    const forged = { ...t.report("base"), run: { ...t.report("base").run, fingerprint: { ...t.baseRun.run.fingerprint, judgmentHash: t.head.judgmentHash } } };
    expect(await t.call("POST", "/v1/projects/bot/reports/runs", forged)).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("another judgmentHash") } } });
    // A refused report leaves no version behind.
    expect((await t.call("GET", "/v1/projects/bot/rubrics")).body.data).toEqual([]);
    await t.call("POST", `/v1/projects/bot/rubrics/intent/versions`, { id: t.base.id, rubric: t.base.rubric });
    expect((await t.call("POST", "/v1/projects/bot/reports/runs", bare)).status).toBe(201);
    expect((await t.call("POST", "/v1/projects/bot/reports/runs", { ...bare, name: "Not A Slug" })).status).toBe(400);
    expect((await t.call("POST", "/v1/projects/bot/reports/runs", { ...bare, run: { ...bare.run, id: "../x" } })).status).toBe(400);
  });

  it("lists reports newest run first, by rubric, version and dataset, within the tenant", async () => {
    const t = await setup();
    await t.call("POST", "/v1/projects/bot/reports/runs", t.report("base"));
    await t.call("POST", "/v1/projects/bot/reports/runs", t.report("head"));
    const ids = async (q = "") => (await t.call("GET", `/v1/projects/bot/reports/runs${q}`)).body.data.map((r: { summary: { runId: string } }) => r.summary.runId);
    expect((await ids()).sort()).toEqual([t.baseRun.run.id, t.headRun.run.id].sort());
    expect(await ids(`?versionId=${t.head.id}`)).toEqual([t.headRun.run.id]);
    expect(await ids("?name=urgency")).toEqual([]);
    expect(await ids("?dataset=cases.jsonl&limit=1")).toHaveLength(1);
    expect(await ids("?dataset=other.jsonl")).toEqual([]);
    expect((await t.call("GET", "/v1/projects/bot/reports/runs", undefined, "sk_other")).status).toBe(404);
    expect((await t.call("GET", `/v1/projects/bot/reports/runs/${t.headRun.run.id}`, undefined, "sk_other")).status).toBe(404);
  });
});

describe("comparison reports", () => {
  it("keeps the counts of a comparison between two reported runs, without per-case rows", async () => {
    const t = await setup();
    const request = comparisonReportRequest("intent", t.comparison, { commit: "abc123" });
    expect(await t.call("POST", "/v1/projects/bot/reports/comparisons", request)).toMatchObject({ status: 400, body: { error: { type: "unknown_run" } } });
    expect((await t.call("POST", "/v1/projects/nope/reports/comparisons", request)).status).toBe(404);
    await t.call("POST", "/v1/projects/bot/reports/runs", t.report("base"));
    await t.call("POST", "/v1/projects/bot/reports/runs", t.report("head"));
    const created = await t.call("POST", "/v1/projects/bot/reports/comparisons", { ...request, comparison: { ...request.comparison, criteria: t.comparison.criteria } });
    expect(created.status).toBe(201);
    expect(created.body.report).toMatchObject({
      id: expect.stringMatching(/^cmp_[0-9a-f]{20}$/), name: "intent", kind: "rubric_change", source: { commit: "abc123" }, actor: { name: "ci" },
      base: { runId: t.baseRun.run.id, rubricVersionId: t.base.id }, head: { runId: t.headRun.run.id, rubricVersionId: t.head.id },
      conditions: { same: false, diffs: [{ field: "judgmentHash" }] },
      criteria: [{ criterionId: "wants", counts: { fixed: 1, kept_match: 2, regressed: 0, cases: 3 }, agreement: { n: 3, base: 2 / 3, head: 1 } }],
    });
    expect(created.body.report.criteria[0]).not.toHaveProperty("cases");
    expect(await t.call("POST", "/v1/projects/bot/reports/comparisons", request)).toMatchObject({ status: 200, body: { created: false, report: { id: created.body.report.id } } });
    const listed = await t.call("GET", `/v1/projects/bot/reports/comparisons?name=intent&head=${t.head.id}`);
    expect(listed.body.data).toHaveLength(1);
    expect((await t.call("GET", `/v1/projects/bot/reports/comparisons?head=${t.base.id}`)).body.data).toEqual([]);
    // The request the builder makes has no rows; rows a client sends anyway (as above) are dropped.
    const kept = await t.store.control.listComparisonReports({ tenantId: "acme", project: "bot" });
    for (const leak of PRIVATE) expect(JSON.stringify([request, kept, created.body, listed.body])).not.toContain(leak);
    // A comparison must name the versions its runs were reported with.
    const swapped = { ...request, comparison: { ...request.comparison, head: { runId: t.headRun.run.id, rubricVersionId: t.base.id } } };
    expect((await t.call("POST", "/v1/projects/bot/reports/comparisons", swapped)).status).toBe(400);
  });
});

describe("who may report", () => {
  it("asks once per report, and that covers the version sent along", async () => {
    const asked: string[] = [];
    const ciOnly: Authorize = ({ action, target }) => { asked.push(`${action}:${target.name ?? ""}:${target.versionId ?? ""}`); return action.startsWith("report.") ? { allow: true } : { allow: false, reason: "forbidden" }; };
    const store = new MemoryStore();
    await store.control.createProject({ tenantId: "acme", name: "bot", createdAt: "2026-11-01T00:00:00.000Z" });
    const t = await setup({ engine: new Engine({ store }), authorize: ciOnly });
    asked.length = 0;
    expect((await t.call("POST", "/v1/projects/bot/reports/runs", t.report("head"))).status).toBe(201);
    expect(asked).toEqual([`report.put:intent:${t.head.id}`]);
    // The same key may not upload a version on its own.
    expect((await t.call("POST", "/v1/projects/bot/rubrics/intent/versions", { id: t.base.id, rubric: t.base.rubric })).status).toBe(403);
    expect((await t.call("GET", "/v1/projects/bot/reports/runs")).status).toBe(200);
  });
});
