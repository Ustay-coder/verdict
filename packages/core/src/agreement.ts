import { coerceScore, criterionScale, denormalizeScore, normalizeScore } from "./aggregate/index.js";
import type { Engine, EvaluateRequest } from "./engine.js";
import type { Evaluation } from "./schema/evaluation.js";
import type { Rubric } from "./schema/rubric.js";
import { Input, type Input as InputT } from "./schema/subject.js";
import { z } from "zod";

/**
 * Check a rubric against people: run it over subjects that humans already judged and report how often Verdict
 * reached the same verdict. Subjects whose evaluation is waiting on a human (low-confidence escalation) count as
 * "asked a human", not as agreements or disagreements.
 */
export const HumanLabel = z.object({
  /** The human's overall verdict, compared with the evaluation's `passed`. */
  passed: z.boolean().optional(),
  /** Per-criterion human scores on the criterion's scale (numbers, labels, or booleans for binary criteria). */
  criteria: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export const GoldItem = z.object({ name: z.string().min(1), inputs: z.array(Input).min(1), human: HumanLabel });
export type GoldItem = z.infer<typeof GoldItem>;

export interface AgreementItem {
  name: string;
  human: z.infer<typeof HumanLabel>;
  /** Verdict's overall verdict; null while the evaluation waits on a human or failed. */
  passed: boolean | null;
  score: number | null;
  /** true / false when both sides have a verdict, null otherwise. */
  agrees: boolean | null;
  askedHuman: boolean;
  /** Per-criterion: Verdict's value on the criterion scale, its confidence, and whether it matches the human. */
  criteria: Record<string, { verdict: number | null; human: number | null; confidence: number | null; agrees: boolean | null; askedHuman: boolean }>;
  evaluationId: string;
  preview?: string;
}

export interface AgreementReport {
  rubric: string;
  batchId?: string;
  items: number;
  /** Subjects Verdict decided by itself, and how many of those match the human verdict. */
  decided: number;
  agreed: number;
  agreement: number | null;
  askedHuman: number;
  failed: number;
  criteria: Record<string, { n: number; agreed: number; agreement: number | null; askedHuman: number }>;
  results: AgreementItem[];
}

/** Parse a gold set: a JSON array or JSON lines. Relative file / image paths resolve against `baseDir`. */
export function parseGoldSet(text: string, baseDir?: string): GoldItem[] {
  const trimmed = text.trim();
  const raw: unknown[] = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  return raw.map((r, i) => {
    const parsed = GoldItem.safeParse(r);
    if (!parsed.success) throw new Error(`gold item ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    const item = parsed.data;
    if (baseDir) item.inputs = item.inputs.map((inp) => resolvePath(inp, baseDir));
    return item;
  });
}

function resolvePath(inp: InputT, baseDir: string): InputT {
  if ((inp.type === "file" || inp.type === "image") && inp.path && !/^([a-zA-Z]:)?[\\/]/.test(inp.path)) return { ...inp, path: `${baseDir.replace(/[\\/]+$/, "")}/${inp.path}` };
  return inp;
}

function preview(inputs: InputT[], max: number): string | undefined {
  const t = inputs.find((i) => i.type === "text");
  return t && t.type === "text" ? (t.text.length > max ? `${t.text.slice(0, max)}…` : t.text) : undefined;
}

/** Compare finished evaluations with their human labels. Pure: never calls judges. */
export function agreementReport(rubric: Rubric, pairs: Array<{ item: GoldItem; evaluation: Evaluation; preview?: string }>, batchId?: string): AgreementReport {
  const criteria: AgreementReport["criteria"] = {};
  const results: AgreementItem[] = pairs.map(({ item, evaluation: ev, preview }) => {
    const askedHuman = ev.status === "pending_human";
    const passed = ev.status === "completed" ? ev.aggregate.passed ?? null : null;
    const per: AgreementItem["criteria"] = {};
    for (const [id, value] of Object.entries(item.human.criteria ?? {})) {
      const criterion = rubric.criteria.find((c) => c.id === id);
      if (!criterion) continue;
      const scale = criterionScale(rubric, criterion);
      const human = coerceScore(typeof value === "boolean" ? Number(value) : value, scale);
      const result = ev.criteria.find((c) => c.criterionId === id);
      const asked = result?.status === "pending";
      const n = result?.status === "scored" && typeof result.normalized === "number" ? result.normalized : null;
      const verdict = n === null ? null : denormalizeScore(n, scale);
      const confidence = result?.ratings.find((r) => typeof r.confidence === "number" && r.judgeType !== "human")?.confidence
        ?? (result?.ratings.find((r) => r.raw?.escalatedFrom)?.raw?.escalatedFrom as { confidence?: number } | undefined)?.confidence ?? null;
      const agrees = verdict === null ? null : verdict === denormalizeScore(normalizeScore(human, scale), scale);
      per[id] = { verdict, human, confidence, agrees, askedHuman: asked };
      const c = (criteria[id] ??= { n: 0, agreed: 0, agreement: null, askedHuman: 0 });
      if (asked) c.askedHuman++;
      else if (agrees !== null) { c.n++; if (agrees) c.agreed++; }
    }
    const agrees = passed === null || item.human.passed === undefined ? null : passed === item.human.passed;
    return { name: item.name, human: item.human, passed, score: ev.aggregate?.score ?? null, agrees, askedHuman, criteria: per, evaluationId: ev.id, ...(preview ? { preview } : {}) };
  });
  for (const c of Object.values(criteria)) c.agreement = c.n ? c.agreed / c.n : null;
  const decided = results.filter((r) => r.agrees !== null).length;
  const agreed = results.filter((r) => r.agrees === true).length;
  return {
    rubric: rubric.name, ...(batchId ? { batchId } : {}), items: results.length, decided, agreed, agreement: decided ? agreed / decided : null,
    askedHuman: results.filter((r) => r.askedHuman).length, failed: pairs.filter((p) => p.evaluation.status === "failed").length, criteria, results,
  };
}

/** Run `rubric` over every gold item (one batch) and report agreement with the human labels. */
export async function checkAgainstHumans(engine: Engine, rubric: EvaluateRequest["rubric"], items: GoldItem[], opts: { previewChars?: number; tenantId?: string } = {}): Promise<AgreementReport> {
  if (!items.length) throw new Error("the gold set is empty");
  const { rubric: resolved } = await engine.resolveRubric(rubric, opts.tenantId);
  const { evaluations } = await engine.evaluateBatch(resolved, items.map((i) => ({ name: i.name, inputs: i.inputs, metadata: { human: i.human } })), { tenantId: opts.tenantId });
  const max = opts.previewChars ?? 240;
  return agreementReport(resolved, items.map((item, i) => ({ item, evaluation: evaluations[i]!, preview: max > 0 ? preview(item.inputs, max) : undefined })), evaluations[0]?.batchId);
}
