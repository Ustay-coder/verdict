import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addFollowUp, createChangeTest, createDatasetVersion, createTrial, currentRevision, Engine, executeTrial, FileStore, freezeRubric, inspectOutput, interruptTrial,
  MemoryStore, observeTrial, planTrial, resolveFollowUp, reverifyTrial, reviseExpectations, seedChangeDemo, trialConditions,
  type ChangeWorkbench, type Evaluation, type RubricVersion, type Trial,
} from "../src/index.js";

const OPEN = { open: { state: "needs_info", requests: [{ field: "paid", question: "How many pay?" }] } };
/** A one-criterion rubric whose scripted judge answers by a word in the document. `points` is what "some" is worth. */
const rubric = (points: number, script: unknown[] = SCRIPT, extra: Record<string, unknown> = {}) => ({
  name: "Customers", defaultJudge: { type: "decision", provider: "mock", options: { script } },
  criteria: [{ id: "q", name: "Customers", scale: { type: "numeric", min: 0, max: 10 }, choices: { all: "all pay", some: "some pay", none: "none", open: "cannot tell" }, values: { all: 10, some: points, none: 0 }, unresolved: OPEN, ...extra }],
});
const says = (when: string, choose: string) => ({ when, answers: { q: { choose: [choose] } } });
const SCRIPT = [says("alpha", "all"), says("beta", "some"), says("gamma", "open"), { when: "delta", error: "scripted outage" }];
const doc = (id: string, text = id) => ({ id, name: id, inputs: [{ type: "text" as const, text }], human: {} });

async function setup(store: ChangeWorkbench = new MemoryStore(), ids = ["alpha", "beta", "gamma"], opts: { script?: unknown[]; tenantId?: string } = {}) {
  const engine = new Engine({ store });
  const keep = async (v: RubricVersion) => { await store.putRubricVersion(v); return v; };
  const tenant = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const v1 = await keep(await freezeRubric(rubric(10, opts.script), tenant)), v2 = await keep(await freezeRubric(rubric(6, opts.script), tenant)), v3 = await keep(await freezeRubric(rubric(4, opts.script), tenant));
  const dataset = await createDatasetVersion(ids.map((id) => doc(id)), tenant);
  await store.putDatasetVersion(dataset);
  const test = await createChangeTest(store, {
    name: "paying customers", intent: "count only paying customers", baselineVersionId: v1.id, candidateVersionId: v2.id, datasetVersionId: dataset.id,
    cases: Object.fromEntries(Object.entries({ alpha: [{ type: "hold", criterion: "q" }], beta: [{ type: "decrease", criterion: "q", by: 4 }] }).filter(([id]) => ids.includes(id))),
  }, tenant);
  const start = async (candidate = v2.id, o: Parameters<typeof createTrial>[3] = {}, run: Parameters<typeof executeTrial>[3] = {}) => {
    const { trial } = await createTrial(store, test.id, candidate, { ...tenant, ...o });
    return executeTrial(engine, store, trial.id, { ...tenant, ...run });
  };
  return { store, engine, v1, v2, v3, dataset, test, start };
}
const verdicts = (trial: Trial, at = -1) => Object.fromEntries(Object.entries(trial.verifications.at(at)!.cases).map(([id, v]) => [id, v.status]));
const evaluationIds = (trial: Trial, side: "baseline" | "candidate") => Object.fromEntries(trial[side].cases.map((c) => [c.caseId, c.evaluationId]));

describe("running a change test", () => {
  it("evaluates both versions case by case and verifies what was expected; a case without expectations is unverified", async () => {
    const t = await setup();
    expect(await planTrial(t.store, t.test, t.v2.id)).toMatchObject({ evaluations: 6, reused: 0 });
    const trial = await t.start();
    expect(trial).toMatchObject({ status: "completed", revision: 1, origin: { kind: "new" }, baseline: { versionId: t.v1.id }, candidate: { versionId: t.v2.id } });
    expect(trial.candidate.cases.every((c) => c.status === "completed" && c.evaluationId && c.startedAt && c.finishedAt)).toBe(true);
    expect(verdicts(trial)).toEqual({ alpha: "met", beta: "met", gamma: "unverified" });
    expect(trial.verifications[0]).toMatchObject({ id: "ver_1", kind: "after_run", revision: 1, summary: { cases: 3, verification: { met: 2, unverified: 1, verifiable: 2 }, judgment: { scored: 2, needs_info: 1, newlyNeedsInfo: 0 } } });
    const seen = await observeTrial(t.store, t.test, trial);
    expect(await trialConditions(seen)).toMatchObject({ rubricOnly: true, mock: true, scripted: true, models: { head: [{ provider: "mock", verified: true }] } });
    expect(await t.store.getTrial(trial.id)).toEqual(trial);
  });

  it("gives the judge the rubric and the document and nothing of what the test expects", async () => {
    const store = new MemoryStore();
    const bodies: string[] = [];
    const fetchJudge = (async (_url: unknown, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ choice: "some", score: 0, confidence: 0.9, rationale: "two of three pay", quotes: [] })); }) as typeof fetch;
    const engine = new Engine({ store, fetch: fetchJudge });
    const judge = { type: "llm", provider: "http", baseUrl: "https://judge.test/score" };
    const versions = await Promise.all([10, 6].map(async (points) => { const v = await freezeRubric({ ...rubric(points), defaultJudge: judge }); await store.putRubricVersion(v); return v; }));
    const dataset = await createDatasetVersion([doc("alpha", "ZETA-DOCUMENT three customers")]);
    await store.putDatasetVersion(dataset);
    const test = await createChangeTest(store, {
      name: "SECRET-TEST-NAME", intent: "SECRET-INTENT must drop", baselineVersionId: versions[0]!.id, candidateVersionId: versions[1]!.id, datasetVersionId: dataset.id,
      cases: { alpha: [{ type: "decrease", criterion: "q", by: 4, note: "SECRET-NOTE" }, { type: "range", criterion: "q", min: 6, max: 6 }] },
    });
    const { trial } = await createTrial(store, test.id, versions[1]!.id);
    const done = await executeTrial(engine, store, trial.id);
    expect(verdicts(done)).toEqual({ alpha: "met" });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain("ZETA-DOCUMENT");
      expect(body).not.toMatch(/SECRET|decrease|tolerance|expect|"by"|baseline|candidate/i);
    }
    // Neither side is told the other's result: the candidate's request names no score of the baseline's.
    expect(bodies[1]).not.toContain(done.baseline.cases[0]!.evaluationId!);
    // The model is named by the judge only, so the page cannot call the two sides the same model.
    expect((await trialConditions(await observeTrial(store, test, done))).differences.map((d) => d.field)).toEqual(["modelsUnverified"]);
  });

  it("keeps a partly failed trial as it is; a retry is a new trial that evaluates only what failed and says what it reused", async () => {
    const t = await setup(new MemoryStore(), ["alpha", "beta", "delta"]);
    await reviseExpectations(t.store, t.test.id, { cases: { ...currentRevision(t.test).cases, delta: [{ type: "hold", criterion: "q" }] } });
    const first = await t.start();
    expect(first.status).toBe("partial");
    expect(first.candidate.cases.map((c) => [c.caseId, c.status])).toEqual([["alpha", "completed"], ["beta", "completed"], ["delta", "failed"]]);
    expect(first.candidate.cases[2]!.error).toContain("scripted outage");
    expect(verdicts(first)).toEqual({ alpha: "met", beta: "met", delta: "incomparable" });
    expect(first.verifications[0]!.summary).toMatchObject({ execution: { evaluated: 2, failed: 1, unfinished: 0 }, verification: { met: 2, incomparable: 1, verifiable: 2 } });

    // The provider recovers: the same versions, with the outage rule gone from nowhere — a retry re-asks only delta.
    const plan = await planTrial(t.store, t.test, t.v2.id, { origin: { kind: "retry", of: first.id } });
    expect(plan).toMatchObject({ evaluations: 2, reused: 4 });
    const retry = await t.start(t.v2.id, { origin: { kind: "retry", of: first.id } });
    expect(retry.id).not.toBe(first.id);
    expect(retry.origin).toEqual({ kind: "retry", of: first.id });
    expect(retry.candidate.cases.map((c) => [c.caseId, c.reusedFrom])).toEqual([["alpha", first.id], ["beta", first.id], ["delta", undefined]]);
    expect(evaluationIds(retry, "candidate").alpha).toBe(evaluationIds(first, "candidate").alpha);
    expect(await t.store.getTrial(first.id)).toEqual(first);

    const rerun = await t.start(t.v2.id, { origin: { kind: "rerun", of: first.id } });
    expect([...rerun.baseline.cases, ...rerun.candidate.cases].some((c) => c.reusedFrom)).toBe(false);
    expect(evaluationIds(rerun, "candidate").alpha).not.toBe(evaluationIds(first, "candidate").alpha);
    expect((await t.store.listTrials({ testId: t.test.id })).map((x) => x.id).sort()).toEqual([first.id, retry.id, rerun.id].sort());
    await expect(createTrial(t.store, t.test.id, t.v2.id, { origin: { kind: "retry", of: "trial_nope" } })).rejects.toThrow(/trial trial_nope not found/);
  });

  it("measures every later candidate from the same baseline, showing the baseline's stored results again", async () => {
    const t = await setup();
    const first = await t.start();
    expect(await planTrial(t.store, t.test, t.v3.id)).toMatchObject({ evaluations: 3, reused: 3 });
    const later = await t.start(t.v3.id);
    expect(later.baseline.versionId).toBe(t.v1.id);
    expect(later.baseline.cases.every((c) => c.reusedFrom === first.id)).toBe(true);
    expect(evaluationIds(later, "baseline")).toEqual(evaluationIds(first, "baseline"));
    // beta: 10 → 4 against v1, a drop of 6 — not "4 more than v2".
    expect(later.verifications[0]!.cases.beta!.expectations[0]).toMatchObject({ status: "met", observed: { base: 10, head: 4, delta: -6 } });
    const fresh = await t.start(t.v3.id, { reuseBaseline: false });
    expect(fresh.baseline.cases.some((c) => c.reusedFrom)).toBe(false);
  });

  it("starts nothing twice: a second request while a trial is queued or running gets that trial", async () => {
    const t = await setup();
    const a = await createTrial(t.store, t.test.id, t.v2.id), b = await createTrial(t.store, t.test.id, t.v2.id);
    expect(b).toMatchObject({ existing: true, trial: { id: a.trial.id } });
    expect((await createTrial(t.store, t.test.id, t.v3.id)).existing).toBe(false);
    await executeTrial(t.engine, t.store, a.trial.id);
    await expect(executeTrial(t.engine, t.store, a.trial.id)).rejects.toThrow(/is completed; start a new trial/);
    expect((await createTrial(t.store, t.test.id, t.v2.id)).existing).toBe(false);
  });

  it("stops at a cancel: finished cases stay, the rest are cancelled and not counted as anything else", async () => {
    const t = await setup();
    const { trial } = await createTrial(t.store, t.test.id, t.v2.id);
    const abort = new AbortController();
    const original = t.engine.evaluate.bind(t.engine);
    let calls = 0;
    t.engine.evaluate = async (...args) => { const ev = await original(...args); if (++calls === 2) abort.abort(); return ev; };
    const done = await executeTrial(t.engine, t.store, trial.id, { signal: abort.signal, concurrency: 1 });
    expect(done.status).toBe("cancelled");
    const statuses = [...done.baseline.cases, ...done.candidate.cases].map((c) => c.status);
    expect(statuses.filter((s) => s === "completed")).toHaveLength(2);
    expect(statuses.filter((s) => s === "cancelled")).toHaveLength(4);
    expect(done.verifications[0]!.summary).toMatchObject({ execution: { evaluated: 0, failed: 0, unfinished: 3 }, verification: { met: 0, verifiable: 0 } });
    expect(verdicts(done)).toEqual({ alpha: "incomparable", beta: "incomparable", gamma: "unverified" });
  });

  it("records a judge call cut short by a cancel as cancelled, not as a failure of the judge", async () => {
    const store = new MemoryStore();
    const abort = new AbortController();
    // The judge answers the baseline, then hangs until the request is aborted.
    let calls = 0;
    const fetchJudge = ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (++calls === 1) return resolve(new Response(JSON.stringify({ choice: "all", score: 0, confidence: 1, rationale: "", quotes: [] })));
      init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      abort.abort();
    })) as typeof fetch;
    const engine = new Engine({ store, fetch: fetchJudge });
    const judge = { type: "llm", provider: "http", baseUrl: "https://judge.test/score" };
    const [v1, v2] = await Promise.all([10, 6].map(async (points) => { const v = await freezeRubric({ ...rubric(points), defaultJudge: judge }); await store.putRubricVersion(v); return v; }));
    const dataset = await createDatasetVersion([doc("alpha")]);
    await store.putDatasetVersion(dataset);
    const test = await createChangeTest(store, { name: "n", intent: "", baselineVersionId: v1!.id, datasetVersionId: dataset.id, cases: { alpha: [{ type: "hold", criterion: "q" }] } });
    const { trial } = await createTrial(store, test.id, v2!.id);
    const done = await executeTrial(engine, store, trial.id, { signal: abort.signal, concurrency: 1 });
    expect(done.status).toBe("cancelled");
    expect([done.baseline.cases[0]!.status, done.candidate.cases[0]!.status]).toEqual(["completed", "cancelled"]);
    expect(done.candidate.cases[0]!.error).toBeUndefined();
    expect(done.verifications[0]!.cases.alpha!.expectations[0]).toMatchObject({ status: "incomparable", code: "candidate_cancelled" });
  });

  it("ends a trial whose runner is gone without touching what finished", async () => {
    const t = await setup();
    const { trial } = await createTrial(t.store, t.test.id, t.v2.id);
    const ended = await interruptTrial(t.store, trial.id, "the process that ran it stopped");
    expect(ended).toMatchObject({ status: "cancelled", error: "the process that ran it stopped" });
    expect(ended.candidate.cases.every((c) => c.status === "cancelled")).toBe(true);
    expect(await interruptTrial(t.store, trial.id, "again")).toEqual(ended);
  });
});

describe("revising what a test expects", () => {
  it("adds a revision and a new verification; earlier ones stay, and no judge is asked", async () => {
    const t = await setup();
    const trial = await t.start();
    const evaluations = t.store instanceof MemoryStore ? t.store.evaluations.size : 0;
    const revised = await reviseExpectations(t.store, t.test.id, { note: "beta should hold after all", cases: { alpha: [{ type: "hold", criterion: "q" }], beta: [{ type: "hold", criterion: "q" }], gamma: [{ type: "asks_for", criterion: "q", fields: ["paid"] }] } });
    expect(revised.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revised.revisions[0]).toEqual(t.test.revisions[0]);
    expect(revised.history.map((h) => h.action)).toEqual(["created", "expectations_revised"]);
    const again = await reverifyTrial(t.store, trial.id);
    expect(again.verifications.map((v) => [v.id, v.kind, v.revision])).toEqual([["ver_1", "after_run", 1], ["ver_2", "reverify", 2]]);
    expect(again.verifications[0]).toEqual(trial.verifications[0]);
    expect(verdicts(again, 0)).toEqual({ alpha: "met", beta: "met", gamma: "unverified" });
    expect(verdicts(again, 1)).toEqual({ alpha: "met", beta: "unmet", gamma: "met" });
    expect((t.store as MemoryStore).evaluations.size).toBe(evaluations);
    expect((await reverifyTrial(t.store, trial.id, { revision: 1 })).verifications.at(-1)).toMatchObject({ id: "ver_3", kind: "reverify", revision: 1 });
    await expect(reverifyTrial(t.store, trial.id, { revision: 9 })).rejects.toThrow(/no revision 9/);
  });

  it("moving the baseline is a revision of its own, and trials of the old baseline are not read against it", async () => {
    const t = await setup();
    const trial = await t.start();
    const moved = await reviseExpectations(t.store, t.test.id, { baselineVersionId: t.v2.id, cases: { beta: [{ type: "decrease", criterion: "q", by: 2 }] } });
    expect(currentRevision(moved)).toMatchObject({ revision: 2, baselineVersionId: t.v2.id });
    expect(moved.history.at(-1)).toMatchObject({ action: "baseline_changed", detail: expect.stringContaining(`${t.v1.id} → ${t.v2.id}`) });
    await expect(reverifyTrial(t.store, trial.id)).rejects.toThrow(/measures from rv_\w+, and this trial ran rv_\w+ as its baseline: start a new trial/);
    const next = await t.start(t.v3.id);
    expect(next).toMatchObject({ revision: 2, baseline: { versionId: t.v2.id } });
    expect(next.verifications[0]!.cases.beta!.expectations[0]).toMatchObject({ status: "met", observed: { base: 6, head: 4, delta: -2 } });
  });

  it("refuses expectations about cases, criteria or versions that are not there", async () => {
    const t = await setup();
    const make = (over: Record<string, unknown>) => createChangeTest(t.store, { name: "n", intent: "", baselineVersionId: t.v1.id, datasetVersionId: t.dataset.id, cases: {}, ...over });
    await expect(make({ cases: { nope: [{ type: "hold" }] } })).rejects.toThrow(/case nope is not in the document set/);
    await expect(make({ cases: { alpha: [{ type: "hold", criterion: "other" }] } })).rejects.toThrow(/criterion other is in neither version/);
    await expect(make({ baselineVersionId: "rv_nope" })).rejects.toThrow(/no rubric version rv_nope/);
    await expect(make({ datasetVersionId: "dsv_nope" })).rejects.toThrow(/no document set dsv_nope/);
    await expect(make({ mapping: { q: "gone" } })).rejects.toThrow(/gone is not a criterion of the baseline/);
    await expect(make({ name: " " })).rejects.toThrow(/needs a name/);
    await expect(reviseExpectations(t.store, "ct_nope", { cases: {} })).rejects.toThrow(/change test ct_nope not found/);
  });

  it("keeps follow-ups with the test without changing any result", async () => {
    const t = await setup();
    const trial = await t.start();
    const flagged = await addFollowUp(t.store, t.test.id, { caseId: "beta", trialId: trial.id, note: "check with the programme owner" });
    expect(flagged.followUps).toMatchObject([{ caseId: "beta", trialId: trial.id, note: "check with the programme owner" }]);
    const resolved = await resolveFollowUp(t.store, t.test.id, flagged.followUps[0]!.id);
    expect(resolved.followUps[0]!.resolvedAt).toBeDefined();
    await expect(resolveFollowUp(t.store, t.test.id, flagged.followUps[0]!.id)).rejects.toThrow(/no open follow-up/);
    expect(await t.store.getTrial(trial.id)).toEqual(trial);
  });
});

describe("stored output that cannot be trusted", () => {
  it("is reported, not repaired: an open judgement with a score, a final total beside it, an unknown criterion, a score off the scale", async () => {
    const t = await setup();
    const trial = await t.start();
    const load = async (caseId: string) => (await t.store.getEvaluation(trial.candidate.cases.find((c) => c.caseId === caseId)!.evaluationId!))!;
    const gamma = await load("gamma"), beta = await load("beta");
    expect(inspectOutput(t.v2, gamma)).toEqual([]);
    const codes = (ev: Evaluation) => inspectOutput(t.v2, ev).map((i) => i.code);
    const contradicting: Evaluation = { ...gamma, criteria: [{ ...gamma.criteria[0]!, score: 0, normalized: 0 }], aggregate: { ...gamma.aggregate, score: 0, partial: false } };
    expect(codes(contradicting)).toEqual(["open_with_score", "open_with_final_total"]);
    expect(inspectOutput(t.v2, contradicting)[1]!.message).toBe("q is still open, yet a final total of 0 is stored");
    expect(codes({ ...beta, criteria: [{ ...beta.criteria[0]!, score: 14 }] })).toEqual(["score_out_of_range"]);
    expect(codes({ ...beta, criteria: [{ ...beta.criteria[0]!, criterionId: "ghost" }] })).toEqual(["unknown_criterion", "missing_criterion"]);
    expect(codes({ ...beta, criteria: [{ ...beta.criteria[0]!, choice: "maybe" }] })).toEqual(["unknown_choice"]);
    expect(codes({ ...beta, criteria: [{ ...beta.criteria[0]!, score: undefined, normalized: undefined }] })).toEqual(["scored_without_score"]);

    // Read through a trial, the case becomes invalid output: an execution problem, with no score and no delta.
    await t.store.putEvaluation(contradicting);
    await reviseExpectations(t.store, t.test.id, { cases: { gamma: [{ type: "asks_for", criterion: "q", fields: ["paid"] }, { type: "range", criterion: "q", min: 0, max: 0 }] } });
    const again = await reverifyTrial(t.store, trial.id);
    const seen = (await observeTrial(t.store, t.test, again)).cases.find((c) => c.caseId === "gamma")!.head;
    expect(seen).toMatchObject({ execution: "invalid_output", state: null, total: null, criteria: [] });
    expect(again.verifications.at(-1)!.cases.gamma).toMatchObject({ status: "incomparable", expectations: [{ code: "candidate_invalid_output" }, { code: "candidate_invalid_output" }] });
    expect(again.verifications.at(-1)!.summary).toMatchObject({ execution: { evaluated: 2, failed: 1 }, verification: { met: 0, incomparable: 1, unverified: 2 } });
  });
});

describe("where tests and trials are kept", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("survives a new process: a file store opened again reads the same test, trial and results", async () => {
    dir = await mkdtemp(join(tmpdir(), "verdict-change-"));
    const t = await setup(new FileStore(dir));
    const trial = await t.start();
    await reviseExpectations(t.store, t.test.id, { cases: { beta: [{ type: "hold", criterion: "q" }] } });
    const reopened = new FileStore(dir);
    expect(await reopened.getTrial(trial.id)).toEqual(trial);
    const test = (await reopened.getChangeTest(t.test.id))!;
    expect(test.revisions).toHaveLength(2);
    expect((await reopened.listChangeTests()).map((x) => x.id)).toEqual([t.test.id]);
    expect((await reopened.listTrials({ testId: t.test.id })).map((x) => x.id)).toEqual([trial.id]);
    expect((await reopened.listDatasetVersions()).map((d) => d.id)).toEqual([t.dataset.id]);
    expect(verdicts(await reverifyTrial(reopened, trial.id))).toEqual({ alpha: "unverified", beta: "unmet", gamma: "unverified" });
    expect((await observeTrial(reopened, test, trial)).cases.map((c) => c.head.criteria[0]!.score)).toEqual([10, 6, null]);
  });

  it("scopes every read to the tenant, in memory and on disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "verdict-change-"));
    for (const store of [new MemoryStore(), new FileStore(dir)]) {
      const t = await setup(store, ["alpha"], { tenantId: "acme" });
      const trial = await t.start();
      expect(trial.tenantId).toBe("acme");
      expect(await store.getChangeTest(t.test.id, "acme")).toBeDefined();
      expect(await store.getChangeTest(t.test.id, "other")).toBeUndefined();
      expect(await store.getTrial(trial.id, "other")).toBeUndefined();
      expect(await store.listChangeTests({ tenantId: "other" })).toEqual([]);
      expect(await store.listTrials({ tenantId: "other", testId: t.test.id })).toEqual([]);
      await expect(createTrial(store, t.test.id, t.v2.id, { tenantId: "other" })).rejects.toThrow(/not found/);
      await expect(reverifyTrial(store, trial.id, { tenantId: "other" })).rejects.toThrow(/not found/);
      await expect(reviseExpectations(store, t.test.id, { cases: {} }, { tenantId: "other" })).rejects.toThrow(/not found/);
      // The evaluations a trial made carry the tenant too.
      expect(await store.getEvaluation(trial.candidate.cases[0]!.evaluationId!, "other")).toBeUndefined();
    }
  });

  it("the demo works on disk too", async () => {
    dir = await mkdtemp(join(tmpdir(), "verdict-change-"));
    const store = new FileStore(dir);
    const { tests } = await seedChangeDemo(new Engine({ store, ingest: { allowLocalFiles: true } }), store);
    expect(tests.map((t) => t.trial.status)).toEqual(["completed", "partial"]);
  });
});
