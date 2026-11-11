/**
 * What `verdict watch` shows for a set of stored evaluations. Pure, so the live page, tests and recorded replays all
 * use the same function.
 *   - The newest finished evaluation alone: its score, gates and criteria, its text next to the previous evaluation of
 *     the same rubric (for a changed-lines view), and the rubric's score history.
 *   - The newest finished batch: a leaderboard. When the same rubric has compared the same subjects before (an agent
 *     improving one entry and comparing again), each row also carries its score in every round and its previous rank.
 */
import type { Evaluation } from "@verdict-ai/core";

export interface WatchCriterion { id: string; name: string; weight: number; status: string; normalized?: number; choice?: string; gateFailed?: string; rationale?: string }
export interface WatchEntry {
  id: string; name: string; status: string; score?: number; range: [number, number] | null; grade?: string; passed?: boolean;
  gatesFailed: string[]; criteria: WatchCriterion[]; evidence: Array<{ label: string; kind: string; text: string }>; createdAt: string; updatedAt: string;
  /** Leaderboard: this subject's score in each round of the rubric so far, oldest first; the last is this one. */
  rounds?: Array<number | undefined>;
  /** Leaderboard: its rank in the previous round, when it was in it. */
  prevRank?: number;
}
export interface WatchState {
  updatedAt?: string;
  view: "empty" | "single" | "leaderboard";
  rubric?: { name: string; version: string };
  aggregation?: { method: string; formula?: string };
  /** Single: [current]. Leaderboard: ranked best first. */
  entries: WatchEntry[];
  /** Single: the previous evaluation of the same rubric. */
  previous?: WatchEntry;
  /** Single: scores of this rubric's evaluations, oldest first. */
  history: Array<{ id: string; name: string; score?: number; grade?: string }>;
  /** Leaderboard: which round (batch) of this rubric is shown, counting from 1. */
  round?: number;
  /** Evaluations still running; the page keeps the last finished result until they land. */
  running: number;
}

// Images and other binary evidence have no text worth showing; their placeholder line is enough.
const TEXT_KINDS = new Set(["text", "file", "json", "url", "youtube"]);
// why: the page re-renders every poll; cap what one evaluation can push into it.
const MAX_EVIDENCE_CHARS = 8000, MAX_RATIONALE_CHARS = 400;

const isRunning = (e: Evaluation) => e.status === "queued" || e.status === "running";
const rubricKey = (e: Evaluation) => e.rubricId ?? `${e.rubric.name}@${e.rubric.version}`;
const byScore = (a: WatchEntry, b: WatchEntry) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.name.localeCompare(b.name);

function entry(ev: Evaluation): WatchEntry {
  const a = ev.aggregate;
  return {
    id: ev.id, name: ev.subject.name ?? ev.evidence[0]?.label ?? ev.id, status: ev.status,
    score: a.score, range: a.range, grade: a.grade, passed: a.passed,
    gatesFailed: a.gates.filter((g) => !g.passed).map((g) => g.message ?? `${g.criterion} below its gate`),
    criteria: ev.criteria.map((c) => ({
      id: c.criterionId, name: c.name, weight: c.weight, status: c.status, normalized: c.normalized, choice: c.choice,
      gateFailed: c.gate && !c.gate.passed ? c.gate.message ?? "gate failed" : undefined,
      rationale: c.ratings.find((r) => r.rationale)?.rationale?.slice(0, MAX_RATIONALE_CHARS),
    })),
    evidence: ev.evidence.filter((e) => TEXT_KINDS.has(e.kind)).map((e) => ({ label: e.label, kind: e.kind, text: e.text.slice(0, MAX_EVIDENCE_CHARS) })),
    createdAt: ev.createdAt, updatedAt: ev.updatedAt,
  };
}

/** Builds the page state; never throws for any list of stored evaluations. */
export function watchState(evaluations: Evaluation[]): WatchState {
  const running = evaluations.filter(isRunning).length;
  const finished = evaluations.filter((e) => !isRunning(e)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.createdAt.localeCompare(b.createdAt));
  const latest = finished.at(-1);
  if (!latest) return { view: "empty", entries: [], history: [], running };
  const base = {
    running, updatedAt: latest.updatedAt, rubric: { name: latest.rubric.name, version: latest.rubric.version },
    aggregation: { method: latest.rubric.aggregation.method, formula: latest.rubric.aggregation.formula },
  };
  return latest.batchId ? { ...base, ...leaderboard(evaluations, finished, latest.batchId) } : { ...base, ...single(finished, latest) };
}

function single(finished: Evaluation[], latest: Evaluation): Pick<WatchState, "view" | "entries" | "previous" | "history"> {
  const same = finished.filter((e) => !e.batchId && rubricKey(e) === rubricKey(latest)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const i = same.findIndex((e) => e.id === latest.id);
  return {
    view: "single", entries: [entry(latest)], previous: i > 0 ? entry(same[i - 1]!) : undefined,
    history: same.slice(0, i + 1).map((e) => ({ id: e.id, name: e.subject.name ?? e.id, score: e.aggregate.score, grade: e.aggregate.grade })),
  };
}

function leaderboard(all: Evaluation[], finished: Evaluation[], latestBatch: string): Pick<WatchState, "view" | "entries" | "history" | "round"> {
  // A batch lands one evaluation at a time: keep showing the newest batch that has finished completely.
  const unfinished = new Set(all.filter((e) => e.batchId && isRunning(e)).map((e) => e.batchId));
  const shown = [...finished].reverse().find((e) => e.batchId && !unfinished.has(e.batchId))?.batchId ?? latestBatch;
  const batch = finished.filter((e) => e.batchId === shown);
  const entries = batch.map(entry).sort(byScore);
  const rounds = roundsUpTo(finished, unfinished, rubricKey(batch[0]!), shown);
  if (rounds.length > 1) addRoundHistory(entries, rounds.map((id) => finished.filter((e) => e.batchId === id).map(entry).sort(byScore)));
  return { view: "leaderboard", entries, history: [], round: rounds.length || undefined };
}

/** Finished batches of the same rubric, in the order they started, up to and including `shown`. */
function roundsUpTo(finished: Evaluation[], unfinished: Set<string | undefined>, key: string, shown: string): string[] {
  const started = new Map<string, string>();
  for (const e of finished) {
    if (!e.batchId || unfinished.has(e.batchId) || rubricKey(e) !== key) continue;
    const first = started.get(e.batchId);
    if (first === undefined || e.createdAt < first) started.set(e.batchId, e.createdAt);
  }
  const ordered = [...started.keys()].sort((a, b) => started.get(a)!.localeCompare(started.get(b)!));
  return ordered.slice(0, ordered.indexOf(shown) + 1);
}

// Subjects are matched across rounds by name: ids change every round, names are what the caller kept stable.
function addRoundHistory(entries: WatchEntry[], byRound: WatchEntry[][]) {
  const previous = byRound.at(-2)!;
  for (const e of entries) {
    e.rounds = byRound.map((r) => r.find((x) => x.name === e.name)?.score);
    const i = previous.findIndex((x) => x.name === e.name);
    if (i >= 0) e.prevRank = i + 1;
  }
}
