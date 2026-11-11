/**
 * What the comparison screen of `verdict watch` shows (docs/design/hub.md §11): two stored runs compared case by case,
 * both rubric versions as text for a side-by-side diff, and enough of each case to read it without opening files.
 * It only reads the store and calls `compareRuns`, which never calls a judge.
 */
import {
  compareRuns, rubricToYaml, ValidationError,
  type Comparison, type DatasetVersion, type Evaluation, type Input, type Run, type RubricVersion, type Store, type VersionStore,
} from "@verdict-ai/core";

export interface RunOption { id: string; label: string; rubricVersionId: string; datasetVersionId: string; startedAt: string; status: string }
export interface VersionView { id: string; rubricKey: string; yaml: string; parentVersionId?: string; changeKinds?: string[]; note?: string }
export interface CaseView { name: string; preview: string; labelSource?: string; split?: string; kind?: string }

export interface CompareView {
  runs: RunOption[];
  /** Label sets the selected runs were made with; either can score both sides. */
  labelSets: Array<{ id: string; name?: string }>;
  selection?: { base: string; head: string; labels: string };
  comparison?: Comparison;
  versions?: { base: VersionView; head: VersionView };
  cases?: Record<string, CaseView>;
  /** Why nothing is compared yet, in words for the page. */
  notice?: string;
}

export interface CompareQuery { base?: string; head?: string; labels?: string; nearMargin?: number }

// why: the picker lists recent runs; older ones stay reachable by id in the URL.
const RUN_LIMIT = 200, PREVIEW_CHARS = 600;

/** Builds the screen for a query; a missing run or label set becomes a notice, not an exception. */
export async function compareView(store: Store & VersionStore, query: CompareQuery): Promise<CompareView> {
  const runs = await store.listRuns({ limit: RUN_LIMIT });
  const options = await Promise.all(runs.map((r) => runOption(store, r)));
  const pair = pickPair(runs, query);
  if (!pair) return { runs: options, labelSets: [], notice: runs.length ? "Pick two runs to compare." : "No runs yet. `verdict run` or `verdict diff` stores them here." };
  try {
    return { runs: options, ...(await comparePair(store, pair, query)) };
  } catch (error) {
    return { runs: options, labelSets: [], notice: error instanceof Error ? error.message : String(error) };
  }
}

/** The asked-for pair, else the newest run against the latest earlier run over the same inputs. */
function pickPair(runs: Run[], q: CompareQuery): { base: string; head: string } | undefined {
  if (q.base && q.head) return { base: q.base, head: q.head };
  const head = q.head ? runs.find((r) => r.id === q.head) : runs[0];
  if (!head) return undefined;
  const base = q.base ?? runs.find((r) => r.id !== head.id && r.fingerprint.casesHash === head.fingerprint.casesHash)?.id;
  return base ? { base, head: head.id } : undefined;
}

async function comparePair(store: Store & VersionStore, pair: { base: string; head: string }, q: CompareQuery): Promise<Omit<CompareView, "runs">> {
  const [base, head] = await Promise.all([loadSide(store, pair.base), loadSide(store, pair.head)]);
  const labelIds = [...new Set([head.run.datasetVersionId, base.run.datasetVersionId])];
  const labelsId = q.labels ?? head.run.datasetVersionId;
  const labels = await store.getDatasetVersion(labelsId);
  if (!labels) throw new ValidationError(`label set ${labelsId} is not in this data directory`);
  const sets = await Promise.all(labelIds.map((id) => store.getDatasetVersion(id)));
  const comparison = compareRuns(base, head, labels, q.nearMargin ? { nearMargin: q.nearMargin } : {});
  return {
    labelSets: sets.filter((d): d is DatasetVersion => !!d).map((d) => ({ id: d.id, ...(d.name ? { name: d.name } : {}) })),
    selection: { base: pair.base, head: pair.head, labels: labels.id },
    comparison,
    versions: { base: versionView(base.version), head: versionView(head.version) },
    cases: caseViews(labels, [...head.evaluations, ...base.evaluations]),
  };
}

async function loadSide(store: Store & VersionStore, id: string): Promise<{ run: Run; version: RubricVersion; evaluations: Evaluation[] }> {
  const run = await store.getRun(id);
  if (!run) throw new ValidationError(`run ${id} is not in this data directory`);
  const version = await store.getRubricVersion(run.rubricVersionId);
  if (!version) throw new ValidationError(`rubric version ${run.rubricVersionId} of ${id} is missing`);
  const evaluations = (await Promise.all(run.cases.map((c) => store.getEvaluation(c.evaluationId)))).filter((e): e is Evaluation => !!e);
  return { run, version, evaluations };
}

async function runOption(store: VersionStore, run: Run): Promise<RunOption> {
  const [version, dataset] = await Promise.all([store.getRubricVersion(run.rubricVersionId), store.getDatasetVersion(run.datasetVersionId)]);
  const label = `${version?.rubricKey ?? "?"} · ${run.rubricVersionId.slice(0, 10)} · ${dataset?.name ?? run.datasetVersionId.slice(0, 10)} · ${run.startedAt.slice(0, 16).replace("T", " ")}`;
  return { id: run.id, label, rubricVersionId: run.rubricVersionId, datasetVersionId: run.datasetVersionId, startedAt: run.startedAt, status: run.status };
}

function versionView(v: RubricVersion): VersionView {
  return {
    id: v.id, rubricKey: v.rubricKey, yaml: rubricToYaml(v.rubric),
    ...(v.parentVersionId ? { parentVersionId: v.parentVersionId } : {}),
    ...(v.fork ? { changeKinds: v.fork.changeKinds, ...(v.fork.note ? { note: v.fork.note } : {}) } : {}),
  };
}

// Inputs come from the label set; the stored evaluation fills in for cases the labels no longer list.
function caseViews(labels: DatasetVersion, evaluations: Evaluation[]): Record<string, CaseView> {
  const views: Record<string, CaseView> = {};
  for (const ev of evaluations) {
    const id = ev.subject.metadata?.caseId;
    if (typeof id === "string" && !views[id]) views[id] = { name: ev.subject.name ?? id, preview: preview(ev.subject.inputs) };
  }
  for (const c of labels.cases) {
    views[c.id] = { name: c.name, preview: preview(c.inputs), ...(c.labelSource ? { labelSource: c.labelSource } : {}), ...(c.split ? { split: c.split } : {}), ...(c.kind ? { kind: c.kind } : {}) };
  }
  return views;
}

function preview(inputs: Input[]): string {
  const parts = inputs.map((i) => (i.type === "text" ? i.text : i.type === "json" ? JSON.stringify(i.data, null, 1) : i.type === "url" || i.type === "youtube" ? i.url : `[${i.type}]`));
  const text = parts.join("\n").trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}
