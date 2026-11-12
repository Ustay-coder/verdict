/**
 * `--models`: the same rubric judged by other decision models, without editing it. A model is named by a short alias
 * (`jev`, `clef`, `clef-flash`, `gemini`) or as `provider:model` (`typesafe:jev-1.14.0`, `openrouter:typesafe/jev-1.13`,
 * `openai:<model>`, `systemone:<model>` with SYSTEMONE_BASE_URL). Only decision judges are re-pointed: rules, people
 * and prompted judges answer as the rubric says. The questions a model receives do not change with the model.
 */
import { DecisionProvider, parseRubric, ValidationError, type JudgeSpec, type Rubric } from "@verdict-ai/core";

export interface ModelChoice { /** As the person wrote it: the name used in the table. */ label: string; provider: DecisionProvider; model?: string }

const ALIASES: Record<string, Omit<ModelChoice, "label">> = {
  jev: { provider: "typesafe", model: "jev-latest" },
  "jev-preview": { provider: "typesafe", model: "jev-preview" },
  clef: { provider: "cloudflare", model: "@cf/cloudflare/clef" },
  "clef-flash": { provider: "cloudflare", model: "@cf/cloudflare/clef-flash" },
  gemini: { provider: "gemini", model: "gemini-decision-1" },
  mock: { provider: "mock" },
};
const PROVIDERS = DecisionProvider.options as readonly string[];

function choice(spec: string): ModelChoice {
  const alias = ALIASES[spec];
  if (alias) return { label: spec, ...alias };
  const at = spec.indexOf(":"), provider = at < 0 ? spec : spec.slice(0, at), model = at < 0 ? "" : spec.slice(at + 1);
  if (!PROVIDERS.includes(provider)) throw new ValidationError(`--models "${spec}": use ${Object.keys(ALIASES).filter((a) => a !== "mock").join(", ")}, or provider:model with one of ${PROVIDERS.join(", ")}`);
  return { label: spec, provider: provider as DecisionProvider, ...(model ? { model } : {}) };
}

/** `jev,clef,openrouter:typesafe/jev-1.13` as choices, in the order given. */
export function parseModels(list: string): ModelChoice[] {
  const specs = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (!specs.length) throw new ValidationError("--models: name at least one model, for example --models jev,clef");
  const repeated = specs.find((s, i) => specs.indexOf(s) !== i);
  if (repeated) throw new ValidationError(`--models: ${repeated} is named twice`);
  return specs.map(choice);
}

/** What a decision judge keeps when another model takes its place: what it asks for, not how its old provider was reached. */
function repointed(judge: Record<string, unknown>, to: ModelChoice): Record<string, unknown> {
  const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, options, model: _model, ...kept } = judge;
  const limit = (options as { stateCharLimit?: unknown } | undefined)?.stateCharLimit;
  return { ...kept, provider: to.provider, ...(to.model ? { model: to.model } : {}), ...(limit !== undefined ? { options: { stateCharLimit: limit } } : {}) };
}

/** The rubric with every decision judge answered by `to`, panels included. Everything else is as it was. */
export function withModel(rubric: Rubric, to: ModelChoice): Rubric {
  const walk = (j: unknown): unknown => {
    if (!j || typeof j !== "object") return j;
    const o = j as Record<string, unknown>;
    if (o.type === "decision") return repointed(o, to);
    if (o.type === "panel") return { ...o, judges: (o.judges as unknown[]).map(walk) };
    return j;
  };
  return parseRubric({
    ...rubric,
    judges: Object.fromEntries(Object.entries(rubric.judges).map(([k, v]) => [k, walk(v)])),
    defaultJudge: walk(rubric.defaultJudge),
    checksJudge: rubric.checksJudge ? walk(rubric.checksJudge) : undefined,
    criteria: rubric.criteria.map((c) => ({ ...c, judge: Array.isArray(c.judge) ? c.judge.map(walk) : walk(c.judge) })),
  });
}

/** Whether any criterion is answered by a decision model: without one there is nothing for another model to answer. */
export function asksDecisionModel(rubric: Rubric): boolean {
  const reaches = (j: JudgeSpec | undefined, seen: string[] = []): boolean => {
    if (!j) return false;
    if (j.type === "decision") return true;
    if (j.type === "panel") return j.judges.some((member) => reaches(member, seen));
    if (j.type === "ref") return !seen.includes(j.ref) && reaches(rubric.judges[j.ref], [...seen, j.ref]);
    return false;
  };
  return rubric.criteria.some((c) => (Array.isArray(c.judge) ? c.judge : [c.judge ?? rubric.defaultJudge]).some((j) => reaches(j)));
}
