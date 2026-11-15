/**
 * What the change-test screens of `verdict watch` show (docs/design/change-tests.md §8). Everything is read from the
 * store and computed by core: observations, score changes and verifications come from the same functions a trial
 * uses, so the page cannot disagree with the record. Building a view never calls a judge.
 */
import {
  currentRevision, observeTrial, planTrial, rubricChanges, rubricToYaml, scoreChange, trialConditions, ValidationError,
  type ChangeTest, type ChangeWorkbench, type DatasetVersion, type Evaluation, type Expectation, type FollowUp, type Input, type JudgeSpec, type Rubric,
  type RubricChange, type RubricVersion, type ScoreChange, type SideObservation, type Trial, type TrialConditions, type Verification, type VerificationSummary,
} from "@verdict-ai/core";

export interface JudgeConnection {
  where: string; type: string; provider?: string; model?: string;
  /** `mock`: answers come from the mock provider. `ready`: the key it needs is set. `missing`: it is not. `none`: needs no key. */
  state: "mock" | "ready" | "missing" | "none";
  /** What is missing or what the mock does, in words. */
  note: string;
}
export interface CriterionOption { id: string; name: string; description?: string; range: [number, number]; fields: string[]; options?: Record<string, string>; values?: Record<string, number> }
export interface VersionView { id: string; rubricKey: string; name: string; version: string; createdAt: string; yaml: string; criteria: CriterionOption[]; judges: JudgeConnection[] }
export interface VersionOption { id: string; label: string; rubricKey: string }
export interface DatasetOption { id: string; label: string; cases: number }
export interface TrialSummary {
  id: string; status: Trial["status"]; origin: Trial["origin"]; candidateVersionId: string; baselineVersionId: string; revision: number; createdAt: string; finishedAt?: string; error?: string;
  progress: { total: number; done: number; failed: number; cancelled: number; reused: number };
  summary?: VerificationSummary;
}
export interface TestSummary { id: string; name: string; intent: string; demo: boolean; createdAt: string; cases: number; revision: number; openFollowUps: number; latest?: TrialSummary }
export interface ChangeIndexView { tests: TestSummary[]; versions: VersionOption[]; datasets: DatasetOption[]; writable: boolean; notice?: string }

export interface DocumentView { caseId: string; name: string; preview: string }
export interface TestView {
  test: ChangeTest;
  baseline: VersionView;
  candidate?: VersionView;
  changes: RubricChange[];
  documents: DocumentView[];
  dataset: DatasetOption;
  trials: TrialSummary[];
  versions: VersionOption[];
  /** What a trial of the shown candidate would evaluate now. */
  estimate?: { documents: number; evaluations: number; reused: number };
  writable: boolean;
}

export interface CaseRow {
  caseId: string; name: string;
  base: SideObservation; head: SideObservation;
  /** By target: `total`, or a criterion id of the candidate. */
  changes: Record<string, ScoreChange>;
  /** The text the judges read, per input, as extracted for the candidate's evaluation (the baseline's when there is none). */
  document: Array<{ inputIndex: number; label: string; text: string; truncated: boolean }>;
  expectations: Expectation[];
  followUp?: FollowUp;
}
export interface TrialView {
  test: { id: string; name: string; intent: string; demo: boolean; revisions: Array<{ revision: number; createdAt: string; note?: string; baselineVersionId: string }>; followUps: FollowUp[] };
  trial: TrialSummary & { startedAt?: string; verifications: Array<{ id: string; revision: number; kind: Verification["kind"]; createdAt: string }> };
  verification?: Verification;
  conditions: TrialConditions;
  baseline: VersionView; candidate: VersionView;
  changes: RubricChange[];
  /** Targets a score can be shown for: `total` first, then every criterion of the candidate. */
  targets: Array<{ id: string; label: string }>;
  cases: CaseRow[];
  writable: boolean;
}

const PREVIEW_CHARS = 400, DOCUMENT_CHARS = 20_000, LIST_LIMIT = 200;

const DECISION_KEYS: Record<string, string[]> = { typesafe: ["TYPESAFE_API_KEY"], cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], openrouter: ["OPENROUTER_API_KEY"], openai: ["OPENAI_API_KEY"], gemini: ["GEMINI_API_KEY"], systemone: ["SYSTEMONE_API_KEY"] };
const LLM_KEYS: Record<string, string[]> = { anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"], cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], http: [] };

type Env = (name: string) => string | undefined;

/** The keys a model judge needs and which of them are not set. */
function missingKeys(spec: Extract<JudgeSpec, { type: "decision" | "llm" }>, env: Env): { needed: string[]; missing: string[] } {
  const needed = spec.apiKeyEnv ? [spec.apiKeyEnv] : (spec.type === "decision" ? DECISION_KEYS : LLM_KEYS)[spec.provider] ?? [];
  // Gemini reads either name.
  const set = (name: string) => !!env(name) || (name === "GEMINI_API_KEY" && !!env("GOOGLE_API_KEY"));
  return { needed, missing: needed.filter((name) => !set(name)) };
}

/** Whether a judge can be reached, judged by its keys alone: nothing is called to find out. */
export function judgeConnection(where: string, spec: JudgeSpec, env: Env): JudgeConnection[] {
  if (spec.type === "panel") return spec.judges.flatMap((member, i) => judgeConnection(`${where}[${i}]`, member, env));
  if (spec.type === "ref") return [];
  if (spec.type !== "decision" && spec.type !== "llm") return [{ where, type: spec.type, state: "none", note: spec.type === "human" ? "a person answers" : "computed, no model" }];
  const base = { where, type: spec.type, provider: spec.provider, ...(spec.model ? { model: spec.model } : {}) };
  if (spec.provider === "mock") {
    const scripted = Array.isArray(spec.options?.script);
    return [{ ...base, state: "mock", note: scripted ? "scripted mock: answers are written into the rubric, not judged by a model" : "mock: a deterministic stand-in, not a model" }];
  }
  const { needed, missing } = missingKeys(spec, env);
  if (missing.length) return [{ ...base, state: "missing", note: `${missing.join(" and ")} is not set where verdict watch runs` }];
  return [{ ...base, state: needed.length ? "ready" : "none", note: needed.length ? `${needed.join(", ")} is set (not checked against the provider)` : "no key needed" }];
}

function connections(rubric: Rubric, env: Env): JudgeConnection[] {
  const named = Object.entries(rubric.judges).flatMap(([name, spec]) => judgeConnection(`judges.${name}`, spec, env));
  const perCriterion = rubric.criteria.flatMap((c) => [c.judge ?? []].flat().flatMap((spec, i) => judgeConnection(`${c.id}.judge[${i}]`, spec, env)));
  return [...judgeConnection("defaultJudge", rubric.defaultJudge, env), ...named, ...perCriterion];
}

function scaleRange(rubric: Rubric, c: Rubric["criteria"][number]): [number, number] {
  const scale = c.scale ?? rubric.scale;
  if (scale.type === "numeric") return [scale.min, scale.max];
  if (scale.type === "binary") return [0, 1];
  const values = scale.values ?? scale.labels.map((_, i) => i);
  return [Math.min(...values), Math.max(...values)];
}

export function versionView(v: RubricVersion, env: Env): VersionView {
  const criteria = v.rubric.criteria.map((c) => ({
    id: c.id, name: c.name, range: scaleRange(v.rubric, c), ...(c.description ? { description: c.description } : {}),
    ...(c.choices ? { options: c.choices } : {}), ...(c.values ? { values: c.values } : {}),
    fields: [...new Set(Object.values(c.unresolved ?? {}).flatMap((o) => (o.requests ?? []).map((r) => r.field)))],
  }));
  return { id: v.id, rubricKey: v.rubricKey, name: v.rubric.name, version: v.rubric.version, createdAt: v.createdAt, yaml: rubricToYaml(v.rubric), criteria, judges: connections(v.rubric, env) };
}

const versionOption = (v: RubricVersion): VersionOption => ({ id: v.id, rubricKey: v.rubricKey, label: `${v.rubric.name} · v${v.rubric.version} · ${v.id.slice(0, 11)} · ${v.createdAt.slice(0, 16).replace("T", " ")}` });
const datasetOption = (d: DatasetVersion): DatasetOption => ({ id: d.id, cases: d.cases.length, label: `${d.name ?? d.id.slice(0, 12)} · ${d.cases.length} document${d.cases.length === 1 ? "" : "s"} · ${d.createdAt.slice(0, 16).replace("T", " ")}` });

function preview(inputs: Input[], max: number): string {
  const text = inputs.map((i) => (i.type === "text" ? i.text : i.type === "json" ? JSON.stringify(i.data, null, 1) : i.type === "url" || i.type === "youtube" ? i.url : `[${i.type}${"path" in i && i.path ? ` ${i.path}` : ""}]`)).join("\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function trialSummary(trial: Trial): TrialSummary {
  const all = [...trial.baseline.cases, ...trial.candidate.cases];
  const count = (status: string) => all.filter((c) => c.status === status).length;
  const summary = trial.verifications.at(-1)?.summary;
  return {
    id: trial.id, status: trial.status, origin: trial.origin, candidateVersionId: trial.candidate.versionId, baselineVersionId: trial.baseline.versionId, revision: trial.revision, createdAt: trial.createdAt,
    ...(trial.finishedAt ? { finishedAt: trial.finishedAt } : {}), ...(trial.error ? { error: trial.error } : {}),
    progress: { total: all.length, done: count("completed"), failed: count("failed"), cancelled: count("cancelled"), reused: all.filter((c) => c.reusedFrom).length },
    ...(summary ? { summary } : {}),
  };
}

export interface ViewOptions { writable: boolean; env: Env }

export async function changeIndex(store: ChangeWorkbench, opts: ViewOptions): Promise<ChangeIndexView> {
  const [tests, versions, datasets, trials] = await Promise.all([store.listChangeTests({ limit: LIST_LIMIT }), store.listRubricVersions({ limit: LIST_LIMIT }), store.listDatasetVersions({ limit: LIST_LIMIT }), store.listTrials({ limit: 1000 })]);
  const summaries = tests.map((t): TestSummary => {
    const latest = trials.find((x) => x.testId === t.id);
    return {
      id: t.id, name: t.name, intent: t.intent, demo: !!t.demo, createdAt: t.createdAt, revision: currentRevision(t).revision,
      cases: datasets.find((d) => d.id === t.datasetVersionId)?.cases.length ?? 0, openFollowUps: t.followUps.filter((f) => !f.resolvedAt).length,
      ...(latest ? { latest: trialSummary(latest) } : {}),
    };
  });
  return { tests: summaries, versions: versions.map(versionOption), datasets: datasets.map(datasetOption), writable: opts.writable };
}

async function requireVersion(store: ChangeWorkbench, id: string): Promise<RubricVersion> {
  const version = await store.getRubricVersion(id);
  if (!version) throw new ValidationError(`rubric version ${id} is not in this data directory`);
  return version;
}

async function requireTest(store: ChangeWorkbench, id: string): Promise<ChangeTest> {
  const test = await store.getChangeTest(id);
  if (!test) throw new ValidationError(`change test ${id} is not in this data directory`);
  return test;
}

export async function testView(store: ChangeWorkbench, testId: string, opts: ViewOptions & { candidate?: string }): Promise<TestView> {
  const test = await requireTest(store, testId);
  const revision = currentRevision(test);
  const dataset = await store.getDatasetVersion(test.datasetVersionId);
  if (!dataset) throw new ValidationError(`document set ${test.datasetVersionId} is not in this data directory`);
  const candidateId = opts.candidate ?? test.candidateVersionId;
  const [baseline, candidate, versions, trials] = await Promise.all([
    requireVersion(store, revision.baselineVersionId), candidateId ? requireVersion(store, candidateId) : undefined,
    store.listRubricVersions({ limit: LIST_LIMIT }), store.listTrials({ testId, limit: LIST_LIMIT }),
  ]);
  const plan = candidate ? await planTrial(store, test, candidate.id) : undefined;
  return {
    test, baseline: versionView(baseline, opts.env), ...(candidate ? { candidate: versionView(candidate, opts.env) } : {}),
    changes: candidate ? rubricChanges(baseline.rubric, candidate.rubric, test.mapping) : [],
    documents: dataset.cases.map((c) => ({ caseId: c.id, name: c.name, preview: preview(c.inputs, PREVIEW_CHARS) })),
    dataset: datasetOption(dataset), trials: trials.map(trialSummary), versions: versions.map(versionOption),
    ...(plan ? { estimate: { documents: dataset.cases.length, evaluations: plan.evaluations, reused: plan.reused } } : {}),
    writable: opts.writable,
  };
}

function documentOf(evaluation: Evaluation | undefined): CaseRow["document"] {
  return (evaluation?.evidence ?? []).map((e) => ({ inputIndex: e.inputIndex, label: e.label, text: e.text.slice(0, DOCUMENT_CHARS), truncated: !!e.truncated || e.text.length > DOCUMENT_CHARS }));
}

export async function trialView(store: ChangeWorkbench, trialId: string, opts: ViewOptions & { verification?: string }): Promise<TrialView> {
  const trial = await store.getTrial(trialId);
  if (!trial) throw new ValidationError(`trial ${trialId} is not in this data directory`);
  const test = await requireTest(store, trial.testId);
  const seen = await observeTrial(store, test, trial);
  const verification = trial.verifications.find((v) => v.id === opts.verification) ?? trial.verifications.at(-1);
  const revision = test.revisions.find((r) => r.revision === (verification?.revision ?? trial.revision));
  const ctx = { base: seen.baseline.rubric, head: seen.candidate.rubric, ...(test.mapping ? { mapping: test.mapping } : {}) };
  const targets = [{ id: "total", label: "Total" }, ...seen.candidate.rubric.criteria.map((c) => ({ id: c.id, label: `${c.name} (${c.id})` }))];
  const cases = seen.cases.map((c): CaseRow => {
    const sides = { base: c.base, head: c.head };
    const followUp = test.followUps.find((f) => f.caseId === c.caseId && !f.resolvedAt);
    return {
      caseId: c.caseId, name: c.name, ...sides,
      changes: Object.fromEntries(targets.map((t) => [t.id, scoreChange(ctx, sides, t.id === "total" ? undefined : t.id)])),
      document: documentOf(c.evaluations.head ?? c.evaluations.base), expectations: revision?.cases[c.caseId] ?? [], ...(followUp ? { followUp } : {}),
    };
  });
  return {
    test: { id: test.id, name: test.name, intent: test.intent, demo: !!test.demo, followUps: test.followUps, revisions: test.revisions.map((r) => ({ revision: r.revision, createdAt: r.createdAt, baselineVersionId: r.baselineVersionId, ...(r.note ? { note: r.note } : {}) })) },
    trial: { ...trialSummary(trial), ...(trial.startedAt ? { startedAt: trial.startedAt } : {}), verifications: trial.verifications.map((v) => ({ id: v.id, revision: v.revision, kind: v.kind, createdAt: v.createdAt })) },
    ...(verification ? { verification } : {}),
    conditions: await trialConditions(seen), baseline: versionView(seen.baseline, opts.env), candidate: versionView(seen.candidate, opts.env),
    changes: rubricChanges(seen.baseline.rubric, seen.candidate.rubric, test.mapping), targets, cases, writable: opts.writable,
  };
}
