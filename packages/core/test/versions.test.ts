import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeKinds, compareRuns, createDatasetVersion, Engine, FileStore, forkDraft, freezeRubric, hasVersions, MemoryStore,
  parseRubric, rescoreRun, runCases, splitRubric, type GoldItem, type RubricVersion,
} from "../src/index.js";

// The mock decision provider picks the choice whose description shares the most words with the state
// (the first option when none do), so editing option descriptions changes answers deterministically.
const triage = {
  name: "Owning team",
  defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "team", name: "Team", choices: { support: "How-to questions", billing: "Invoices and payments", engineering: "Bugs and outages" } }],
};
const ticket = (id: string, text: string, team: string): GoldItem => ({ id, name: id, inputs: [{ type: "text", text }], expected: { team } });
const cases = [ticket("c1", "payments failed twice", "billing"), ticket("c2", "the app has bugs", "engineering"), ticket("c3", "refund please", "billing")];

describe("the fork-and-compare loop (design §17.1)", () => {
  it("runs a version and its fork on the same cases, separates fixes from regressions, and re-scores new labels without judges", async () => {
    const engine = new Engine();
    // 1–2. A rubric version and a small case set; run the original.
    const base = await freezeRubric(triage);
    const v1 = await createDatasetVersion(cases, { name: "triage" });
    const original = await runCases(engine, base, v1);
    expect(original.run).toMatchObject({ status: "completed", rubricVersionId: base.id, datasetVersionId: v1.id, counts: { cases: 3, completed: 3, labelled: 3 } });
    expect(original.report.criteria.team).toMatchObject({ n: 3, agreed: 2 });

    // 3. Fork the exact version and change one condition: refunds are billing; "bugs" no longer names engineering.
    const draft = forkDraft(base);
    draft.criteria[0]!.choices = { support: "How-to questions", billing: "Invoices, payments and refund requests", engineering: "Outages and crashes" };
    const fork = await freezeRubric(draft, { parent: base, note: "refunds belong to billing" });
    expect(fork).toMatchObject({ parentVersionId: base.id, fork: { note: "refunds belong to billing", changeKinds: ["question_text"] } });
    expect(fork.judgmentHash).not.toBe(base.judgmentHash);
    expect(fork.policyHash).toBe(base.policyHash);

    // 4–5. Same cases, same model: the comparison is attributed to the rubric change, case by case.
    const forked = await runCases(engine, fork, v1);
    const first = compareRuns({ ...original, version: base }, { ...forked, version: fork }, v1);
    expect(first.kind).toBe("rubric_change");
    expect(first.conditions.diffs.map((d) => d.field)).toEqual(["judgmentHash", "questionsHash"]);
    const team = first.criteria[0]!;
    expect(team.contract.same).toBe(true);
    expect(team.counts).toMatchObject({ cases: 3, commonSucceeded: 3, labelled: 3, kept_match: 1, fixed: 1, regressed: 1 });
    expect(team.cases.find((c) => c.caseId === "c3")).toMatchObject({ class: "fixed", base: { verdict: "support" }, head: { verdict: "billing" } });
    expect(team.cases.find((c) => c.caseId === "c2")).toMatchObject({ class: "regressed", base: { verdict: "engineering" }, head: { verdict: "support" } });
    expect(team.agreement).toEqual({ n: 3, base: 2 / 3, head: 2 / 3 });

    // 6. Change one expected label: new dataset version, same inputs. Both runs are re-scored, never re-run.
    const v2 = await createDatasetVersion([cases[0]!, ticket("c2", "the app has bugs", "support"), cases[2]!]);
    expect(v2.casesHash).toBe(v1.casesHash);
    expect(v2.labelsHash).not.toBe(v1.labelsHash);
    const calls = original.run.usage.decisionCalls + forked.run.usage.decisionCalls;
    expect(rescoreRun(base, original.run, v2, original.evaluations).criteria.team).toMatchObject({ n: 3, agreed: 1 });
    const relabelled = compareRuns({ ...original, version: base }, { ...forked, version: fork }, v2);
    expect(relabelled.kind).toBe("rubric_change");
    expect(relabelled.labels).toEqual({ datasetVersionId: v2.id, labelsHash: v2.labelsHash, rescored: { base: true, head: true } });
    expect(relabelled.criteria[0]!.counts).toMatchObject({ fixed: 2, regressed: 0, kept_match: 1 });
    expect(original.run.usage.decisionCalls + forked.run.usage.decisionCalls).toBe(calls);
  });

  it("refuses to re-score a run against cases whose inputs changed", async () => {
    const base = await freezeRubric(triage);
    const v1 = await createDatasetVersion(cases);
    const { run, evaluations } = await runCases(new Engine(), base, v1);
    const edited = await createDatasetVersion([ticket("c1", "payments failed three times", "billing"), cases[1]!, cases[2]!]);
    expect(() => rescoreRun(base, run, edited, evaluations)).toThrow(/run the cases again/);
  });
});

describe("rubric versions", () => {
  it("derive their id from content: the same rubric freezes to the same id, whatever its key order or stored id", async () => {
    const a = await freezeRubric(triage);
    const b = await freezeRubric({ criteria: triage.criteria, defaultJudge: triage.defaultJudge, name: triage.name, id: "rub_123" });
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^rv_[0-9a-f]{20}$/);
    expect(b.rubricKey).toBe("rub_123");
    expect((await freezeRubric({ ...triage, name: "Renamed" })).id).not.toBe(a.id);
  });

  it("classify what changed", () => {
    const base = parseRubric({ name: "r", scale: { type: "numeric", min: 1, max: 3 }, defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "q", name: "Quality", anchors: { "1": "poor", "3": "great" } }] });
    const edit = (patch: Record<string, unknown>, criterion: Record<string, unknown> = {}) => parseRubric({ ...base, ...patch, criteria: [{ ...base.criteria[0], ...criterion }] });
    expect(changeKinds(base, base)).toEqual([]);
    expect(changeKinds(base, edit({}, { weight: 2 }))).toEqual(["policy"]);
    expect(changeKinds(base, edit({ defaultJudge: { type: "decision", provider: "mock", model: "other" } }))).toEqual(["binding"]);
    expect(changeKinds(base, edit({ defaultJudge: { type: "decision", provider: "mock", minConfidence: 0.4 } }))).toEqual(["policy"]);
    expect(changeKinds(base, edit({ metadata: { domain: "support" } }))).toEqual(["metadata"]);
    expect(changeKinds(base, edit({}, { description: "Is it clear?" }))).toEqual(["question_text"]);
    expect(changeKinds(base, edit({}, { anchors: { "1": "poor", "2": "fair", "3": "great" } }))).toEqual(["question_text", "output_contract"]);
    expect(changeKinds(base, edit({ inputSchema: { type: "object" } }))).toEqual(["input_schema"]);
    const added = parseRubric({ ...base, criteria: [...base.criteria, { id: "r", name: "Reach" }] });
    expect(changeKinds(base, added)).toContain("criteria_added");
    expect(changeKinds(added, base)).toContain("criteria_removed");
  });

  it("count the rubric name as judgment only when an LLM judge reads it", () => {
    const decision = parseRubric({ name: "a", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "q", name: "Q" }] });
    const llm = parseRubric({ ...decision, defaultJudge: { type: "llm", provider: "mock" } });
    expect(JSON.stringify(splitRubric(decision).judgment)).not.toContain('"name":"a"');
    expect(JSON.stringify(splitRubric(llm).judgment)).toContain('"name":"a"');
    expect(changeKinds(decision, parseRubric({ ...decision, name: "b" }))).toEqual(["metadata"]);
    expect(changeKinds(llm, parseRubric({ ...llm, name: "b" }))).toEqual(["question_text"]);
  });

  it("forks into a draft without the parent's stored id", async () => {
    const parent = await freezeRubric({ ...triage, id: "rub_parent" });
    expect(forkDraft(parent).id).toBeUndefined();
    expect(forkDraft(parent).criteria).toEqual(parent.rubric.criteria);
  });
});

describe("dataset versions", () => {
  it("ignore case order, keep the inputs hash when only labels change, and hash file contents when given a reader", async () => {
    const forward = await createDatasetVersion(cases), backward = await createDatasetVersion([...cases].reverse());
    expect(backward.casesHash).toBe(forward.casesHash);
    expect(backward.labelsHash).toBe(forward.labelsHash);
    expect(backward.id).toBe(forward.id);
    const file = (path: string): GoldItem => ({ id: "f", name: "f", inputs: [{ type: "file", path }], expected: { team: "billing" } });
    const bytes = (text: string) => async () => new TextEncoder().encode(text);
    const a = await createDatasetVersion([file("/a.txt")], { readFile: bytes("same") });
    const b = await createDatasetVersion([file("/b.txt")], { readFile: bytes("same") });
    const c = await createDatasetVersion([file("/a.txt")], { readFile: bytes("changed") });
    expect(b.casesHash).toBe(a.casesHash);
    expect(c.casesHash).not.toBe(a.casesHash);
  });
});

describe("runs and comparisons", () => {
  it("record the models that answered and the questions sent", async () => {
    const { run } = await runCases(new Engine(), await freezeRubric(triage), await createDatasetVersion(cases));
    expect(run.fingerprint.models).toEqual([{ provider: "mock", resolved: "mock-decision", verified: true }]);
    expect(run.fingerprint.questionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.fingerprint.adapterVersion).toBe("decision-questions@1");
    expect(run.cases.map((c) => c.caseId)).toEqual(["c1", "c2", "c3"]);
  });

  it("call a repeat run the same conditions, but never when the provider did not say which model answered", async () => {
    const engine = new Engine();
    const data = await createDatasetVersion(cases);
    const version = await freezeRubric(triage);
    const twice = compareRuns({ ...(await runCases(engine, version, data)), version }, { ...(await runCases(engine, version, data)), version }, data);
    expect(twice).toMatchObject({ kind: "same_conditions", conditions: { same: true, diffs: [] } });
    // A System One endpoint whose responses do not name the model that answered.
    const silent = new Engine({ fetch: (async () => new Response(JSON.stringify({ answers: { team: { type: "choice", choice: "billing" } } }))) as typeof fetch });
    const aliased = await freezeRubric({ ...triage, defaultJudge: { type: "decision", provider: "systemone", baseUrl: "https://decisions.example/v1" } });
    const a = await runCases(silent, aliased, data), b = await runCases(silent, aliased, data);
    expect(a.run.fingerprint.models).toEqual([{ provider: "systemone", requested: "jev-latest", verified: false }]);
    const unverified = compareRuns({ ...a, version: aliased }, { ...b, version: aliased }, data);
    expect(unverified.kind).toBe("different_conditions");
    expect(unverified.conditions.diffs.map((d) => d.field)).toEqual(["modelsUnverified"]);
  });

  it("call a model change a different condition, and flag answers that moved close to flipping", async () => {
    const yesNo = (noul: number) => ({ name: "Wants an agent", defaultJudge: { type: "decision", provider: "mock", options: { noul } }, criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] } }] });
    const data = await createDatasetVersion([{ id: "a", name: "a", inputs: [{ type: "text", text: "connect me" }], expected: { wants: "yes" } }]);
    const engine = new Engine();
    const [sure, unsure] = [await freezeRubric(yesNo(0.9)), await freezeRubric(yesNo(0.58))];
    const comparison = compareRuns({ ...(await runCases(engine, sure, data)), version: sure }, { ...(await runCases(engine, unsure, data)), version: unsure }, data);
    expect(comparison.kind).toBe("different_conditions");
    expect(comparison.conditions.diffs.map((d) => d.field)).toEqual(["bindingHash"]);
    expect(comparison.criteria[0]!.cases[0]).toMatchObject({ class: "kept_match", nearBoundary: true, base: { gap: 0.4 }, head: { gap: 0.08 } });
    expect(comparison.criteria[0]!.counts.nearBoundary).toBe(1);
  });

  it("show changed answer contracts side by side without counting fixes, and keep failed or missing cases out of rates", async () => {
    const scored = { name: "Q", scale: { type: "numeric", min: 1, max: 3 }, defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "q", name: "Q", anchors: { "1": "poor", "3": "great" } }] };
    const finer = { ...scored, criteria: [{ id: "q", name: "Q", anchors: { "1": "poor", "2": "fair", "3": "great" } }] };
    const data = await createDatasetVersion([{ id: "a", name: "a", inputs: [{ type: "text", text: "fine" }], expected: { q: 3 } }]);
    const engine = new Engine();
    const [v1, v2] = [await freezeRubric(scored), await freezeRubric(finer)];
    const r1 = await runCases(engine, v1, data), r2 = await runCases(engine, v2, data);
    const contract = compareRuns({ ...r1, version: v1 }, { ...r2, version: v2 }, data).criteria[0]!;
    expect(contract.contract.same).toBe(false);
    expect(contract.counts).toMatchObject({ incomparable: 1, fixed: 0, regressed: 0 });
    expect(contract.agreement).toEqual({ n: 0, base: null, head: null });

    const withExtra = await createDatasetVersion([...data.cases, { id: "b", name: "b", inputs: [{ type: "text", text: "more" }], expected: { q: 1 } }]);
    const r3 = await runCases(engine, v1, withExtra);
    const missing = compareRuns({ ...r1, version: v1 }, { ...r3, version: v1 }, withExtra);
    expect(missing.conditions.diffs.map((d) => d.field)).toContain("casesHash");
    expect(missing.criteria[0]!.cases.find((c) => c.caseId === "b")).toMatchObject({ class: "missing", base: { status: "missing" } });
    expect(missing.criteria[0]!.agreement.n).toBe(1);
  });
});

describe("version stores", () => {
  const roundTrip = async (store: MemoryStore | FileStore) => {
    expect(hasVersions(store)).toBe(true);
    const version: RubricVersion = { ...(await freezeRubric(triage)), tenantId: "t1" };
    const dataset = { ...(await createDatasetVersion(cases)), tenantId: "t1" };
    const { run } = await runCases(new Engine({ store }), version, dataset, { tenantId: "t1" });
    await store.putRubricVersion(version); await store.putDatasetVersion(dataset); await store.putRun(run);
    expect((await store.getRubricVersion(version.id, "t1"))?.judgmentHash).toBe(version.judgmentHash);
    expect(await store.getRubricVersion(version.id, "t2")).toBeUndefined();
    expect((await store.getDatasetVersion(dataset.id, "t1"))?.cases).toHaveLength(3);
    expect(await store.getRun(run.id, "t2")).toBeUndefined();
    expect((await store.listRuns({ tenantId: "t1", rubricVersionId: version.id })).map((r) => r.id)).toEqual([run.id]);
    expect(await store.listRuns({ tenantId: "t1", rubricVersionId: "rv_other" })).toEqual([]);
    expect((await store.listRubricVersions({ tenantId: "t1", rubricKey: "Owning team" })).map((v) => v.id)).toEqual([version.id]);
  };

  it("keep versions, datasets and runs in memory, tenant-scoped", () => roundTrip(new MemoryStore()));

  it("keep them as JSON files, tenant-scoped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-versions-"));
    try {
      await writeFile(join(dir, "marker"), "");
      await roundTrip(new FileStore(dir));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
