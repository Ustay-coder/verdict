/**
 * Replaces live decision and LLM providers for offline command execution.
 * Human and benchmark semantics remain intact, including judges nested inside panels.
 */
import { parseRubric, type Rubric } from "@verdict-ai/core";

/** Replace every decision / llm judge with its mock provider (for dry runs / CI). */
export function mockify(rubric: Rubric): Rubric {
  const walk = (j: unknown): unknown => {
    if (!j || typeof j !== "object") return j;
    const o = j as Record<string, unknown>;
    if (o.type === "llm" || o.type === "decision") return { ...o, provider: "mock" };
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

