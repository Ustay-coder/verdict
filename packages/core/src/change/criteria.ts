/**
 * How the criteria of two rubric versions correspond, and what changed between them, item by item. Criteria are
 * matched by id — never by name: a renamed id needs the test's explicit `mapping`, and a same-named criterion under
 * another id is reported as unconfirmed rather than assumed to be the same thing.
 */
import { criterionScale, scaleRange } from "../aggregate/index.js";
import { canonicalJson } from "../idempotency.js";
import type { Criterion, Rubric } from "../schema/rubric.js";
import { splitJudge } from "../versions/split.js";

export type Counterpart =
  | { kind: "same" | "mapped"; baseId: string }
  /** Declared new in the mapping, or simply not in the baseline. */
  | { kind: "new" }
  /** Not in the baseline under this id, while baseline criteria carry the same name: a person has to say. */
  | { kind: "unconfirmed"; candidates: string[] }
  /** The id is not in the candidate at all. `renamedTo`: candidate criteria named like the baseline's. */
  | { kind: "gone"; renamedTo: string[] };

const sameName = (a: Criterion, b: Criterion) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

/** The baseline criterion a candidate criterion id is compared with. */
export function counterpart(base: Rubric, head: Rubric, mapping: Record<string, string | null> | undefined, headId: string): Counterpart {
  const target = head.criteria.find((c) => c.id === headId);
  if (!target) {
    const old = base.criteria.find((c) => c.id === headId);
    return { kind: "gone", renamedTo: old ? head.criteria.filter((c) => sameName(c, old) && !base.criteria.some((b) => b.id === c.id)).map((c) => c.id) : [] };
  }
  const mapped = mapping && Object.hasOwn(mapping, headId) ? mapping[headId] : undefined;
  if (mapped === null) return { kind: "new" };
  if (typeof mapped === "string" && base.criteria.some((c) => c.id === mapped)) return { kind: "mapped", baseId: mapped };
  if (base.criteria.some((c) => c.id === headId)) return { kind: "same", baseId: headId };
  const candidates = base.criteria.filter((c) => sameName(c, target) && !head.criteria.some((h) => h.id === c.id)).map((c) => c.id);
  return candidates.length ? { kind: "unconfirmed", candidates } : { kind: "new" };
}

/**
 * `judgment`: what a judge reads or may answer. `policy`: how an answer becomes a score. `binding`: who answers.
 * `structure`: criteria added, removed or re-identified.
 */
export interface RubricChange {
  layer: "structure" | "judgment" | "policy" | "binding";
  kind: "criterion_added" | "criterion_removed" | "criterion_mapped" | "criterion_unconfirmed" | "wording" | "options" | "scoring" | "scale" | "weight" | "threshold" | "open_options" | "optional" | "context" | "aggregation" | "checks" | "judge";
  criterionId?: string;
  summary: string;
  before?: string;
  after?: string;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** A value for a person to read: a flat record as `key: value` lines, anything deeper as indented JSON. */
function show(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v !== "object") return String(v);
  const flat = !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== "object");
  return flat ? Object.entries(v).map(([k, x]) => `${k}: ${String(x)}`).join("\n") : JSON.stringify(v, null, 1);
}

/** Everything that differs between two versions, structure first, then per criterion, then rubric-wide. */
export function rubricChanges(base: Rubric, head: Rubric, mapping?: Record<string, string | null>): RubricChange[] {
  const changes: RubricChange[] = [];
  const matched = new Set<string>();
  for (const c of head.criteria) {
    const found = counterpart(base, head, mapping, c.id);
    if (found.kind === "new") changes.push({ layer: "structure", kind: "criterion_added", criterionId: c.id, summary: `criterion ${c.id} is new`, after: c.name });
    else if (found.kind === "unconfirmed") changes.push({ layer: "structure", kind: "criterion_unconfirmed", criterionId: c.id, summary: `criterion ${c.id} is new by id, but ${found.candidates.join(", ")} in the baseline has the same name: map it or declare it new`, after: c.name });
    else if (found.kind === "same" || found.kind === "mapped") {
      matched.add(found.baseId);
      if (found.kind === "mapped") changes.push({ layer: "structure", kind: "criterion_mapped", criterionId: c.id, summary: `criterion ${found.baseId} is now ${c.id} (mapped by the test)`, before: found.baseId, after: c.id });
      changes.push(...criterionChanges(base, head, base.criteria.find((b) => b.id === found.baseId)!, c));
    }
  }
  for (const b of base.criteria) if (!matched.has(b.id)) changes.push({ layer: "structure", kind: "criterion_removed", criterionId: b.id, summary: `criterion ${b.id} is not in the candidate`, before: b.name });
  return [...changes, ...rubricWideChanges(base, head)];
}

function criterionChanges(baseRubric: Rubric, headRubric: Rubric, b: Criterion, h: Criterion): RubricChange[] {
  const changes: RubricChange[] = [];
  const add = (layer: RubricChange["layer"], kind: RubricChange["kind"], summary: string, before: unknown, after: unknown) => {
    if (!same(before, after)) changes.push({ layer, kind, criterionId: h.id, summary: `${h.id}: ${summary}`, before: show(before), after: show(after) });
  };
  add("judgment", "wording", "the criterion's name or description changed", [b.name, b.description ?? ""].filter(Boolean).join(" — "), [h.name, h.description ?? ""].filter(Boolean).join(" — "));
  add("judgment", "options", "the answers a judge can give changed", answerTexts(b), answerTexts(h));
  add("policy", "scoring", "the points each answer is worth changed", b.values, h.values);
  add("policy", "scale", "the scale changed, so raw scores of the two versions are not comparable", scaleRange(criterionScale(baseRubric, b)), scaleRange(criterionScale(headRubric, h)));
  add("policy", "weight", "the weight changed", b.weight, h.weight);
  add("policy", "threshold", "the yes/no threshold changed", b.threshold, h.threshold);
  add("policy", "open_options", "which answers leave the score open, or what is asked then, changed", b.unresolved, h.unresolved);
  add("policy", "optional", "whether the criterion is optional changed", b.optional, h.optional);
  return changes;
}

function answerTexts(c: Criterion): unknown {
  return c.choices ?? c.levels?.map((l) => `${l.value}: ${l.description}`) ?? c.anchors ?? null;
}

function rubricWideChanges(base: Rubric, head: Rubric): RubricChange[] {
  const changes: RubricChange[] = [];
  const add = (layer: RubricChange["layer"], kind: RubricChange["kind"], summary: string, before: unknown, after: unknown) => {
    if (!same(before, after)) changes.push({ layer, kind, summary, before: show(before), after: show(after) });
  };
  add("judgment", "context", "the context given to every judge changed", base.context, head.context);
  add("policy", "aggregation", "how criteria are combined into the total changed", base.aggregation, head.aggregation);
  add("judgment", "checks", "the pre-screen checks changed", base.checks, head.checks);
  const b = splitJudge(base.defaultJudge), h = splitJudge(head.defaultJudge);
  add("binding", "judge", "the default judge's provider, model or options changed", b.binding, h.binding);
  add("judgment", "judge", "the default judge's type or instructions changed", b.judgment, h.judgment);
  add("policy", "judge", "what happens to a low-confidence answer changed", b.policy, h.policy);
  return changes;
}

/** True when the total of the two versions is built from the same criteria with the same weights. */
export function sameTotalMakeUp(base: Rubric, head: Rubric): boolean {
  const shape = (r: Rubric) => ({ method: r.aggregation.method, formula: r.aggregation.formula, criteria: r.criteria.map((c) => [c.id, c.weight]).sort() });
  return same(shape(base), shape(head));
}
