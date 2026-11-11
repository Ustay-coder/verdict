/**
 * What every control store must do, whichever way it persists (docs/design/control-plane.md). The memory and file
 * stores run it here; the database stores run the same cases from packages/db/test.
 */
import { expect, it } from "vitest";
import { freezeRubric, type ComparisonReport, type ControlStore, type ProjectScope, type ProjectVersion, type PromotionEvent, type RunReport } from "../src/index.js";

const T0 = "2026-11-10T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const A: ProjectScope = { tenantId: "t1", project: "support-bot" };

const rubric = (question: string) => ({
  name: "Intent", defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "q", name: question, scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }],
});

async function version(scope: ProjectScope, name: string, question: string, seconds = 0): Promise<ProjectVersion> {
  const frozen = await freezeRubric(rubric(question), { now: () => Date.parse(at(seconds)) });
  return { ...frozen, ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }), project: scope.project, name };
}

let sequence = 0;
function event(scope: ProjectScope, name: string, from: string | null, to: string | null, o: Partial<PromotionEvent> = {}): PromotionEvent {
  sequence += 1;
  return { ...scope, id: `prm_${String(sequence).padStart(6, "0")}`, environment: "prod", name, from, to, kind: "promote", at: at(sequence), ...o };
}

function runReport(scope: ProjectScope, name: string, runId: string, versionId: string, seconds: number, o: Partial<RunReport> = {}): RunReport {
  return {
    ...scope, name, reportedAt: at(seconds), datasetName: "cases.jsonl",
    summary: {
      runId, origin: "author_reported", rubricVersionId: versionId, datasetVersionId: "dsv_1", status: "completed", startedAt: at(seconds),
      fingerprint: { judgmentHash: "j", policyHash: "p", bindingHash: "b", questionsHash: null, adapterVersion: "q@1", casesHash: "c", labelsHash: "l", models: [], scoring: "agreement@1" },
      counts: { cases: 10, completed: 10, pendingHuman: 0, failed: 0, invalidInput: 0, labelled: 10 },
      agreement: { decided: 10, agreed: 9, criteria: { q: { n: 10, agreed: 9, askedHuman: 0 } } },
    },
    ...o,
  };
}

function comparison(scope: ProjectScope, id: string, headVersionId: string, seconds: number): ComparisonReport {
  return {
    ...scope, id, name: "intent", kind: "rubric_change", reportedAt: at(seconds),
    base: { runId: "run_a", rubricVersionId: "rv_base" }, head: { runId: "run_b", rubricVersionId: headVersionId },
    conditions: { same: false, diffs: [{ field: "judgmentHash", base: "a", head: "b" }] },
    labels: { datasetVersionId: "dsv_1", labelsHash: "l", rescored: { base: false, head: false } },
    criteria: [],
  };
}

async function project(store: ControlStore, scope: ProjectScope = A, environments = ["prod"]) {
  await store.createProject({ ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }), name: scope.project, createdAt: T0 });
  for (const name of environments) await store.createEnvironment({ ...scope, name, createdAt: T0 });
}

/** Registers the shared cases against stores made by `open` (a fresh, empty store per call). */
export function controlStoreContract(open: () => Promise<ControlStore>) {
  it("creates projects and environments once, and refuses an environment without its project", async () => {
    const store = await open();
    expect(await store.createEnvironment({ ...A, name: "prod", createdAt: T0 })).toBe("no_project");
    expect(await store.createProject({ tenantId: "t1", name: "support-bot", createdAt: T0 })).toBe(true);
    expect(await store.createProject({ tenantId: "t1", name: "support-bot", createdAt: at(5) })).toBe(false);
    expect(await store.getProject("t1", "support-bot")).toEqual({ tenantId: "t1", name: "support-bot", createdAt: T0 });
    expect(await store.createEnvironment({ ...A, name: "prod", createdAt: T0 })).toBe("created");
    expect(await store.createEnvironment({ ...A, name: "prod", createdAt: at(5) })).toBe("exists");
    expect(await store.createEnvironment({ ...A, name: "staging", createdAt: at(1) })).toBe("created");
    expect((await store.listEnvironments(A)).map((e) => e.name)).toEqual(["prod", "staging"]);
    expect(await store.getEnvironment(A, "prod")).toEqual({ ...A, name: "prod", createdAt: T0 });
  }, 30000);

  it("keeps tenants and projects apart, and treats a missing tenant as its own scope", async () => {
    const store = await open();
    const other: ProjectScope = { tenantId: "t2", project: "support-bot" }, open1: ProjectScope = { project: "support-bot" }, sibling: ProjectScope = { tenantId: "t1", project: "billing" };
    for (const scope of [A, other, open1, sibling]) await project(store, scope);
    const v = await version(A, "intent", "Wants an agent?");
    await store.putVersion(v);
    expect(await store.getVersion(A, "intent", v.id)).toEqual(v);
    for (const scope of [other, open1, sibling]) {
      expect(await store.getVersion(scope, "intent", v.id)).toBeUndefined();
      expect(await store.listVersions(scope)).toEqual([]);
      // A version id is its content: the same id may exist in another scope without touching this one.
      expect(await store.applyPromotions([event(scope, "intent", null, v.id)])).toEqual({ ok: false, reason: "unknown_version" });
    }
    expect((await store.listProjects("t1")).map((p) => p.name).sort()).toEqual(["billing", "support-bot"]);
    expect((await store.listProjects(undefined)).map((p) => p.name)).toEqual(["support-bot"]);
    expect(await store.getProject(undefined, "billing")).toBeUndefined();
    const copy = await version(open1, "intent", "Wants an agent?");
    expect(await store.putVersion(copy)).toEqual({ created: true, version: copy });
    expect(await store.applyPromotions([event(open1, "intent", null, copy.id)])).toEqual({ ok: true });
    expect(await store.listPointers(A, "prod")).toEqual([]);
    expect((await store.listPointers(open1, "prod")).map((p) => p.versionId)).toEqual([copy.id]);
  }, 30000);

  it("stores a version once under its name and lists a rubric's versions newest first", async () => {
    const store = await open();
    expect(await store.putVersion(await version(A, "intent", "First?"))).toBe("no_project");
    await project(store);
    const first = await version(A, "intent", "First?", 1), second = await version(A, "intent", "Second?", 2), urgency = await version(A, "urgency", "First?", 3);
    expect(await store.putVersion(first)).toEqual({ created: true, version: first });
    expect(await store.putVersion({ ...first, createdAt: at(9) })).toEqual({ created: false, version: first });
    await store.putVersion(second); await store.putVersion(urgency);
    expect(urgency.id).toBe(first.id);
    expect((await store.listVersions(A, { name: "intent" })).map((v) => v.id)).toEqual([second.id, first.id]);
    expect((await store.listVersions(A)).map((v) => v.name)).toEqual(["urgency", "intent", "intent"]);
    expect((await store.listVersions(A, { limit: 1 })).map((v) => v.name)).toEqual(["urgency"]);
    expect(await store.listRubricNames(A)).toEqual([{ name: "intent", versions: 2, updatedAt: at(2) }, { name: "urgency", versions: 1, updatedAt: at(3) }]);
    expect(await store.listRubricNames({ tenantId: "t2", project: A.project })).toEqual([]);
  }, 30000);

  it("moves pointers only from the version the caller saw, all changes or none", async () => {
    const store = await open();
    await project(store);
    const v1 = await version(A, "intent", "One?", 1), v2 = await version(A, "intent", "Two?", 2), u1 = await version(A, "urgency", "Urgent?", 3);
    for (const v of [v1, v2, u1]) await store.putVersion(v);
    const first = event(A, "intent", null, v1.id, { note: "launch", actor: { kind: "key", id: "key_1", name: "deploy" } });
    expect(await store.applyPromotions([first])).toEqual({ ok: true });
    expect(await store.listPointers(A, "prod")).toEqual([{ ...A, environment: "prod", name: "intent", versionId: v1.id, updatedAt: first.at }]);
    // Someone else's view is stale: the pointer is at v1, not unset.
    expect(await store.applyPromotions([event(A, "intent", null, v2.id)])).toEqual({ ok: false, reason: "conflict" });
    // One stale change refuses the whole request, including the change that would have applied.
    expect(await store.applyPromotions([event(A, "urgency", null, u1.id), event(A, "intent", v2.id, v1.id)])).toEqual({ ok: false, reason: "conflict" });
    expect((await store.listPointers(A, "prod")).map((p) => p.name)).toEqual(["intent"]);
    const both = [event(A, "intent", v1.id, v2.id), event(A, "urgency", null, u1.id)];
    expect(await store.applyPromotions(both)).toEqual({ ok: true });
    expect((await store.listPointers(A, "prod")).map((p) => [p.name, p.versionId])).toEqual([["intent", v2.id], ["urgency", u1.id]]);
    expect((await store.listHistory(A)).map((e) => e.id)).toEqual([both[1]!.id, both[0]!.id, first.id]);
    expect((await store.listHistory(A, { name: "intent" })).at(-1)).toEqual(first);
    expect(await store.listHistory(A, { environment: "staging" })).toEqual([]);
    expect((await store.listHistory(A, { limit: 1 })).map((e) => e.id)).toEqual([both[1]!.id]);
  }, 30000);

  it("refuses versions kept under another name, unknown versions and unknown environments", async () => {
    const store = await open();
    await project(store);
    const intent = await version(A, "intent", "One?");
    await store.putVersion(intent);
    expect(await store.applyPromotions([event(A, "urgency", null, intent.id)])).toEqual({ ok: false, reason: "unknown_version" });
    expect(await store.applyPromotions([event(A, "intent", null, "rv_missing")])).toEqual({ ok: false, reason: "unknown_version" });
    expect(await store.applyPromotions([event(A, "intent", null, intent.id, { environment: "staging" })])).toEqual({ ok: false, reason: "no_environment" });
    expect(await store.listHistory(A)).toEqual([]);
  }, 30000);

  it("deletes only versions no pointer names, and lets an unset pointer free its version", async () => {
    const store = await open();
    await project(store, A, ["prod", "staging"]);
    const v1 = await version(A, "intent", "One?", 1), v2 = await version(A, "intent", "Two?", 2);
    await store.putVersion(v1); await store.putVersion(v2);
    await store.applyPromotions([event(A, "intent", null, v1.id, { environment: "staging" })]);
    expect(await store.deleteVersion(A, "intent", v1.id)).toBe("in_use");
    expect(await store.deleteVersion(A, "intent", v2.id)).toBe("deleted");
    expect(await store.deleteVersion(A, "intent", v2.id)).toBe("not_found");
    const unset = event(A, "intent", v1.id, null, { environment: "staging", kind: "unset" });
    expect(await store.applyPromotions([unset])).toEqual({ ok: true });
    expect(await store.listPointers(A, "staging")).toEqual([]);
    expect(await store.deleteVersion(A, "intent", v1.id)).toBe("deleted");
    // The history still names the deleted version.
    expect((await store.listHistory(A)).map((e) => [e.kind, e.from, e.to])).toEqual([["unset", v1.id, null], ["promote", null, v1.id]]);
  }, 30000);

  it("deleting an environment drops its pointers but keeps its history; deleting a project drops everything", async () => {
    const store = await open();
    await project(store, A, ["prod", "staging"]);
    const v1 = await version(A, "intent", "One?");
    await store.putVersion(v1);
    await store.applyPromotions([event(A, "intent", null, v1.id)]);
    await store.putRunReport(runReport(A, "intent", "run_1", v1.id, 1));
    await store.putComparisonReport(comparison(A, "cmp_1", v1.id, 1));
    expect(await store.deleteEnvironment(A, "prod")).toBe(true);
    expect(await store.deleteEnvironment(A, "prod")).toBe(false);
    expect(await store.listPointers(A, "prod")).toEqual([]);
    expect(await store.listHistory(A)).toHaveLength(1);
    expect(await store.deleteVersion(A, "intent", v1.id)).toBe("deleted");
    await store.putVersion(v1);
    expect(await store.deleteProject("t2", "support-bot")).toBe(false);
    expect(await store.deleteProject("t1", "support-bot")).toBe(true);
    expect(await store.getProject("t1", "support-bot")).toBeUndefined();
    // A project of the same name created later starts empty.
    await project(store, A, []);
    expect([await store.listEnvironments(A), await store.listVersions(A), await store.listHistory(A), await store.listRunReports(A), await store.listComparisonReports(A)]).toEqual([[], [], [], [], []]);
  }, 30000);

  it("keeps one report per run and filters reports by rubric, version and dataset", async () => {
    const store = await open();
    expect(await store.putRunReport(runReport(A, "intent", "run_0", "rv_1", 0))).toBe("no_project");
    expect(await store.putComparisonReport(comparison(A, "cmp_0", "rv_1", 0))).toBe("no_project");
    await project(store);
    const first = runReport(A, "intent", "run_1", "rv_1", 1, { source: { commit: "abc", branch: "main" }, usage: { decisionCalls: 1, llmCalls: 0, inputTokens: 20, outputTokens: 2 }, actor: { kind: "key", name: "ci" } });
    expect(await store.putRunReport(first)).toEqual({ created: true, report: first });
    expect(await store.putRunReport({ ...first, reportedAt: at(50) })).toEqual({ created: false, report: first });
    await store.putRunReport(runReport(A, "intent", "run_2", "rv_2", 2, { datasetName: "hard.jsonl" }));
    await store.putRunReport(runReport(A, "urgency", "run_3", "rv_1", 3));
    expect(await store.getRunReport(A, "run_1")).toEqual(first);
    expect(await store.getRunReport({ tenantId: "t2", project: "support-bot" }, "run_1")).toBeUndefined();
    expect((await store.listRunReports(A)).map((r) => r.summary.runId)).toEqual(["run_3", "run_2", "run_1"]);
    expect((await store.listRunReports(A, { name: "intent" })).map((r) => r.summary.runId)).toEqual(["run_2", "run_1"]);
    expect((await store.listRunReports(A, { versionId: "rv_1", limit: 1 })).map((r) => r.summary.runId)).toEqual(["run_3"]);
    expect((await store.listRunReports(A, { datasetName: "hard.jsonl" })).map((r) => r.summary.runId)).toEqual(["run_2"]);
    const c1 = comparison(A, "cmp_1", "rv_1", 1), c2 = comparison(A, "cmp_2", "rv_2", 2);
    expect(await store.putComparisonReport(c1)).toEqual({ created: true, report: c1 });
    expect(await store.putComparisonReport({ ...c1, reportedAt: at(50) })).toEqual({ created: false, report: c1 });
    await store.putComparisonReport(c2);
    expect((await store.listComparisonReports(A)).map((c) => c.id)).toEqual(["cmp_2", "cmp_1"]);
    expect((await store.listComparisonReports(A, { headVersionId: "rv_1" })).map((c) => c.id)).toEqual(["cmp_1"]);
    expect(await store.listComparisonReports(A, { name: "urgency" })).toEqual([]);
  }, 30000);

  it("prunes old history and reports of one tenant, keeping versions and pointers", async () => {
    const store = await open();
    const other: ProjectScope = { tenantId: "t2", project: "support-bot" };
    await project(store); await project(store, other);
    const v1 = await version(A, "intent", "One?"), v2 = await version(A, "intent", "Two?", 1);
    await store.putVersion(v1); await store.putVersion(v2);
    await store.applyPromotions([event(A, "intent", null, v1.id, { at: at(10) })]);
    await store.applyPromotions([event(A, "intent", v1.id, v2.id, { at: at(200) })]);
    await store.putRunReport(runReport(A, "intent", "run_old", v1.id, 10));
    await store.putRunReport(runReport(A, "intent", "run_new", v2.id, 200));
    await store.putRunReport(runReport(other, "intent", "run_theirs", v1.id, 10));
    await store.putComparisonReport(comparison(A, "cmp_old", v1.id, 10));
    await store.prune("t1", at(100));
    expect((await store.listHistory(A)).map((e) => e.to)).toEqual([v2.id]);
    expect((await store.listRunReports(A)).map((r) => r.summary.runId)).toEqual(["run_new"]);
    expect(await store.listComparisonReports(A)).toEqual([]);
    expect((await store.listRunReports(other)).map((r) => r.summary.runId)).toEqual(["run_theirs"]);
    expect((await store.listVersions(A)).map((v) => v.id)).toEqual([v2.id, v1.id]);
    expect((await store.listPointers(A, "prod")).map((p) => p.versionId)).toEqual([v2.id]);
    // However old, the latest change of each pointer stays: it is what a rollback returns from.
    await store.putVersion(await version(A, "urgency", "One?"));
    await store.createEnvironment({ ...A, name: "staging", createdAt: T0 });
    await store.applyPromotions([event(A, "urgency", null, v1.id, { at: at(300) })]);
    await store.applyPromotions([event(A, "intent", null, v1.id, { at: at(310), environment: "staging" })]);
    await store.applyPromotions([event(A, "intent", v1.id, v2.id, { at: at(320), environment: "staging" })]);
    await store.prune("t1", at(100_000));
    expect((await store.listHistory(A)).map((e) => [e.environment, e.name, e.from, e.to])).toEqual([["staging", "intent", v1.id, v2.id], ["prod", "urgency", null, v1.id], ["prod", "intent", v1.id, v2.id]]);
    expect(await store.listRunReports(A)).toEqual([]);
  }, 30000);

  it("counts what a tenant keeps: projects, environments, versions, and reports since a moment", async () => {
    const store = await open();
    const second: ProjectScope = { tenantId: "t1", project: "billing-bot" }, other: ProjectScope = { tenantId: "t2", project: "support-bot" };
    expect(await store.usage("t1", at(0))).toEqual({ projects: 0, environments: 0, versions: 0, reports: 0 });
    await project(store); await project(store, second); await project(store, other);
    await store.createEnvironment({ ...A, name: "staging", createdAt: T0 });
    const v1 = await version(A, "intent", "One?"), v2 = await version(A, "intent", "Two?", 1);
    await store.putVersion(v1); await store.putVersion(v2); await store.putVersion(v1);
    await store.putVersion(await version(second, "intent", "One?"));
    await store.putVersion(await version(other, "intent", "One?"));
    await store.putRunReport(runReport(A, "intent", "run_old", v1.id, 10));
    await store.putRunReport(runReport(A, "intent", "run_new", v2.id, 200));
    await store.putRunReport(runReport(other, "intent", "run_theirs", v1.id, 200));
    await store.putComparisonReport(comparison(A, "cmp_new", v1.id, 200));
    // Each project came with `prod`; the first got `staging` too. A version uploaded twice is one version.
    expect(await store.usage("t1", at(0))).toEqual({ projects: 2, environments: 3, versions: 3, reports: 3 });
    expect(await store.usage("t1", at(100))).toMatchObject({ reports: 2 });
    expect(await store.usage("t2", at(0))).toEqual({ projects: 1, environments: 1, versions: 1, reports: 1 });
    expect(await store.usage(undefined, at(0))).toEqual({ projects: 0, environments: 0, versions: 0, reports: 0 });
  }, 30000);

  it("applies exactly one of two promotions that both saw the same pointer", async () => {
    const store = await open();
    await project(store);
    const v1 = await version(A, "intent", "One?", 1), v2 = await version(A, "intent", "Two?", 2), v3 = await version(A, "intent", "Three?", 3);
    for (const v of [v1, v2, v3]) await store.putVersion(v);
    await store.applyPromotions([event(A, "intent", null, v1.id)]);
    const results = await Promise.all([store.applyPromotions([event(A, "intent", v1.id, v2.id)]), store.applyPromotions([event(A, "intent", v1.id, v3.id)])]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "conflict" }]);
    expect(await store.listHistory(A)).toHaveLength(2);
  }, 30000);
}
