/**
 * Immutable rubric versions. A version's id is derived from its content, so freezing the same rubric twice — on any
 * machine — yields the same id: a lock file, a hub page and a CI run can all name exactly what they ran.
 * Forks record the exact parent version and what changed; nothing flows back to the parent or forward to the fork.
 */
import { canonicalJson, fingerprint } from "../idempotency.js";
import { parseRubric, type Rubric } from "../schema/rubric.js";
import { outputContract, splitRubric } from "./split.js";

/** Change kinds between two versions. `output_contract` means raw values of that criterion are not comparable. */
export const CHANGE_KINDS = ["criteria_added", "criteria_removed", "question_text", "output_contract", "checks", "input_schema", "policy", "binding", "metadata"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface RubricHashes { contentHash: string; judgmentHash: string; policyHash: string; bindingHash: string; metaHash: string }

export interface RubricVersion extends RubricHashes {
  id: string;
  tenantId?: string;
  /** Stable name of the rubric this version belongs to (its stored id, else its name). */
  rubricKey: string;
  rubric: Rubric;
  /** Exact version this one was forked or edited from, when known. */
  parentVersionId?: string;
  /** Human note plus the machine-computed change kinds relative to the parent. */
  fork?: { note?: string; changeKinds: ChangeKind[] };
  createdAt: string;
}

const ID_CHARS = 20;

/** Content hashes of a rubric. The stored id is excluded: the same document under two ids is the same content. */
export async function rubricHashes(rubric: Rubric): Promise<RubricHashes> {
  const { id: _id, ...content } = rubric;
  const parts = splitRubric(rubric);
  const [contentHash, judgmentHash, policyHash, bindingHash, metaHash] = await Promise.all([
    fingerprint(content), fingerprint(parts.judgment), fingerprint(parts.policy), fingerprint(parts.binding), fingerprint(parts.meta),
  ]);
  return { contentHash, judgmentHash, policyHash, bindingHash, metaHash };
}

/** Freezes a rubric (raw or parsed) into a version. Pure apart from the clock; persisting is the caller's choice. */
export async function freezeRubric(input: unknown, opts: { parent?: RubricVersion; note?: string; tenantId?: string; now?: () => number } = {}): Promise<RubricVersion> {
  const rubric = parseRubric(input);
  const hashes = await rubricHashes(rubric);
  const createdAt = new Date((opts.now ?? Date.now)()).toISOString();
  return {
    id: `rv_${hashes.contentHash.slice(0, ID_CHARS)}`,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    rubricKey: rubric.id ?? rubric.name,
    rubric,
    ...hashes,
    ...(opts.parent ? { parentVersionId: opts.parent.id, fork: { ...(opts.note ? { note: opts.note } : {}), changeKinds: changeKinds(opts.parent.rubric, rubric) } } : {}),
    createdAt,
  };
}

/** A fresh, editable copy of a version: no stored id, so saving it never overwrites the parent. */
export function forkDraft(version: RubricVersion): Rubric {
  const { id: _id, ...draft } = structuredClone(version.rubric);
  return draft as Rubric;
}

/**
 * What changed between two rubrics, in `CHANGE_KINDS` order. Empty when only key order or ids differ.
 * `question_text` is a change in what judges read; `output_contract` a change in what an answer can be. Adding a
 * level is usually both: a new description and a new value.
 */
export function changeKinds(before: Rubric, after: Rubric): ChangeKind[] {
  const kinds = new Set<ChangeKind>();
  const a = splitRubric(before), b = splitRubric(after);
  const beforeIds = new Set(before.criteria.map((c) => c.id)), afterIds = new Set(after.criteria.map((c) => c.id));
  if ([...afterIds].some((id) => !beforeIds.has(id))) kinds.add("criteria_added");
  if ([...beforeIds].some((id) => !afterIds.has(id))) kinds.add("criteria_removed");
  for (const c of after.criteria) {
    const old = before.criteria.find((x) => x.id === c.id);
    if (old && !same(outputContract(before, old), outputContract(after, c))) kinds.add("output_contract");
  }
  if (!same(wording(before), wording(after))) kinds.add("question_text");
  if (!same(before.checks?.map(({ id, question, criteria }) => ({ id, question, criteria })), after.checks?.map(({ id, question, criteria }) => ({ id, question, criteria })))) kinds.add("checks");
  if (!same(before.inputSchema, after.inputSchema)) kinds.add("input_schema");
  if (!same(a.policy, b.policy)) kinds.add("policy");
  if (!same(a.binding, b.binding)) kinds.add("binding");
  if (!same(a.meta, b.meta)) kinds.add("metadata");
  return CHANGE_KINDS.filter((k) => kinds.has(k));
}

/** The text judges read: context, criterion names and descriptions, level and option descriptions, judge instructions. */
function wording(r: Rubric) {
  const judgment = splitRubric(r).judgment as { judges: unknown; prompted?: unknown };
  return {
    context: r.context,
    prompted: judgment.prompted,
    judges: judgment.judges,
    criteria: r.criteria.map((c) => ({ id: c.id, name: c.name, description: c.description, inputs: c.inputs, texts: levelTexts(c) })),
  };
}

function levelTexts(c: Rubric["criteria"][number]): unknown {
  if (c.choices) return c.choices;
  if (c.levels) return c.levels.map((l) => l.description);
  return c.anchors ?? null;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
