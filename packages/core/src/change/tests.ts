/**
 * Writing and revising change tests. A test is checked against the versions and documents it names when it is
 * saved, so a trial never meets an expectation about a case or criterion that does not exist. Expectations are
 * never edited in place: each save is a new revision, and moving the baseline is a revision of its own, because
 * every "changed by" is measured from it.
 */
import { NotFoundError, ValidationError } from "../engine/errors.js";
import type { Rubric } from "../schema/rubric.js";
import type { ChangeWorkbench } from "./store.js";
import { Expectation, type ChangeTest, type ExpectationRevision, type FollowUp } from "./types.js";

export interface NewChangeTest {
  name: string; intent: string;
  baselineVersionId: string; candidateVersionId?: string; datasetVersionId: string;
  mapping?: Record<string, string | null>;
  /** Expectations by case id, as written (ids and defaults are filled in). A case left out is unverified. */
  cases: Record<string, unknown[]>;
  note?: string; demo?: boolean;
}
export interface ChangeActor { tenantId?: string; createdBy?: string; now?: () => number }

const iso = (a: ChangeActor) => new Date((a.now ?? Date.now)()).toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Parses expectations and gives each a stable id within its case (`e1`, `e2`, … unless one is written). */
export function parseExpectations(cases: Record<string, unknown[]>): Record<string, Expectation[]> {
  const out: Record<string, Expectation[]> = {};
  for (const [caseId, list] of Object.entries(cases)) {
    if (!Array.isArray(list)) throw new ValidationError(`expectations of case ${caseId} must be a list`);
    const used = new Set<string>();
    out[caseId] = list.map((raw, i) => {
      const parsed = Expectation.safeParse(raw);
      if (!parsed.success) throw new ValidationError(`case ${caseId}, expectation ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "expectation"}: ${x.message}`).join("; ")}`);
      let id = parsed.data.id ?? `e${i + 1}`;
      while (used.has(id)) id = `${id}_${i + 1}`;
      used.add(id);
      return { ...parsed.data, id };
    });
  }
  return out;
}

async function requireVersion(store: ChangeWorkbench, id: string, tenantId?: string): Promise<Rubric> {
  const version = await store.getRubricVersion(id, tenantId);
  if (!version) throw new ValidationError(`no rubric version ${id} in this data directory`);
  return version.rubric;
}

/** Every case and criterion an expectation names must exist; a mapping must point at baseline criteria. */
function checkReferences(cases: Record<string, Expectation[]>, caseIds: Set<string>, rubrics: Rubric[], mapping: Record<string, string | null> | undefined, baseline: Rubric) {
  const criteria = new Set(rubrics.flatMap((r) => r.criteria.map((c) => c.id)));
  for (const [caseId, list] of Object.entries(cases)) {
    if (!caseIds.has(caseId)) throw new ValidationError(`case ${caseId} is not in the document set`);
    for (const e of list) if (e.criterion && !criteria.has(e.criterion)) throw new ValidationError(`case ${caseId}: criterion ${e.criterion} is in neither version`);
  }
  for (const [head, base] of Object.entries(mapping ?? {})) {
    if (base !== null && !baseline.criteria.some((c) => c.id === base)) throw new ValidationError(`mapping ${head} → ${base}: ${base} is not a criterion of the baseline`);
  }
}

export async function createChangeTest(store: ChangeWorkbench, input: NewChangeTest, actor: ChangeActor = {}): Promise<ChangeTest> {
  if (!input.name.trim()) throw new ValidationError("a change test needs a name");
  const dataset = await store.getDatasetVersion(input.datasetVersionId, actor.tenantId);
  if (!dataset) throw new ValidationError(`no document set ${input.datasetVersionId} in this data directory`);
  const baseline = await requireVersion(store, input.baselineVersionId, actor.tenantId);
  const candidate = input.candidateVersionId ? await requireVersion(store, input.candidateVersionId, actor.tenantId) : undefined;
  const cases = parseExpectations(input.cases);
  checkReferences(cases, new Set(dataset.cases.map((c) => c.id)), candidate ? [baseline, candidate] : [baseline], input.mapping, baseline);
  const at = iso(actor);
  const by = actor.createdBy ? { createdBy: actor.createdBy } : {};
  const test: ChangeTest = {
    id: newId("ct"), ...(actor.tenantId ? { tenantId: actor.tenantId } : {}),
    name: input.name.trim(), intent: input.intent.trim(),
    datasetVersionId: dataset.id, casesHash: dataset.casesHash,
    ...(input.candidateVersionId ? { candidateVersionId: input.candidateVersionId } : {}),
    ...(input.mapping && Object.keys(input.mapping).length ? { mapping: input.mapping } : {}),
    revisions: [{ revision: 1, baselineVersionId: input.baselineVersionId, cases, ...(input.note ? { note: input.note } : {}), createdAt: at, ...by }],
    followUps: [], history: [{ at, ...(actor.createdBy ? { by: actor.createdBy } : {}), action: "created" }],
    ...(input.demo ? { demo: true } : {}), ...by, createdAt: at, updatedAt: at,
  };
  await store.putChangeTest(test);
  return test;
}

export async function requireTest(store: ChangeWorkbench, id: string, tenantId?: string): Promise<ChangeTest> {
  const test = await store.getChangeTest(id, tenantId);
  if (!test) throw new NotFoundError(`change test ${id} not found`);
  return test;
}

export const currentRevision = (test: ChangeTest): ExpectationRevision => test.revisions[test.revisions.length - 1]!;

/**
 * Saves new expectations as the next revision. Earlier revisions and every verification made against them stay.
 * Naming another baseline moves the point deltas are measured from, so the expectations must be given again in full.
 */
export async function reviseExpectations(store: ChangeWorkbench, testId: string, input: { cases: Record<string, unknown[]>; baselineVersionId?: string; note?: string }, actor: ChangeActor = {}): Promise<ChangeTest> {
  const test = await requireTest(store, testId, actor.tenantId);
  const previous = currentRevision(test);
  const baselineVersionId = input.baselineVersionId ?? previous.baselineVersionId;
  const baseline = await requireVersion(store, baselineVersionId, actor.tenantId);
  const candidate = test.candidateVersionId ? await requireVersion(store, test.candidateVersionId, actor.tenantId) : undefined;
  const previousBaseline = await requireVersion(store, previous.baselineVersionId, actor.tenantId);
  const dataset = await store.getDatasetVersion(test.datasetVersionId, actor.tenantId);
  if (!dataset) throw new ValidationError(`document set ${test.datasetVersionId} is missing`);
  const cases = parseExpectations(input.cases);
  checkReferences(cases, new Set(dataset.cases.map((c) => c.id)), [baseline, previousBaseline, ...(candidate ? [candidate] : [])], test.mapping, baseline);
  const at = iso(actor);
  const moved = baselineVersionId !== previous.baselineVersionId;
  const revision: ExpectationRevision = { revision: previous.revision + 1, baselineVersionId, cases, ...(input.note ? { note: input.note } : {}), createdAt: at, ...(actor.createdBy ? { createdBy: actor.createdBy } : {}) };
  const entry = { at, ...(actor.createdBy ? { by: actor.createdBy } : {}), action: moved ? "baseline_changed" as const : "expectations_revised" as const, detail: moved ? `revision ${revision.revision}: baseline ${previous.baselineVersionId} → ${baselineVersionId}` : `revision ${revision.revision}` };
  const next: ChangeTest = { ...test, revisions: [...test.revisions, revision], history: [...test.history, entry], updatedAt: at };
  await store.putChangeTest(next);
  return next;
}

/** Marks a case to look at again. It changes no rubric and no score: it is a note that travels with the test. */
export async function addFollowUp(store: ChangeWorkbench, testId: string, input: { caseId: string; trialId: string; note?: string }, actor: ChangeActor = {}): Promise<ChangeTest> {
  const test = await requireTest(store, testId, actor.tenantId);
  const at = iso(actor);
  const followUp: FollowUp = { id: newId("fu"), caseId: input.caseId, trialId: input.trialId, ...(input.note ? { note: input.note } : {}), createdAt: at, ...(actor.createdBy ? { createdBy: actor.createdBy } : {}) };
  const next: ChangeTest = { ...test, followUps: [...test.followUps, followUp], history: [...test.history, { at, action: "follow_up_added", detail: `${input.caseId} (${input.trialId})` }], updatedAt: at };
  await store.putChangeTest(next);
  return next;
}

export async function resolveFollowUp(store: ChangeWorkbench, testId: string, followUpId: string, actor: ChangeActor = {}): Promise<ChangeTest> {
  const test = await requireTest(store, testId, actor.tenantId);
  if (!test.followUps.some((f) => f.id === followUpId && !f.resolvedAt)) throw new NotFoundError(`no open follow-up ${followUpId}`);
  const at = iso(actor);
  const next: ChangeTest = { ...test, followUps: test.followUps.map((f) => (f.id === followUpId ? { ...f, resolvedAt: at } : f)), history: [...test.history, { at, action: "follow_up_resolved", detail: followUpId }], updatedAt: at };
  await store.putChangeTest(next);
  return next;
}
