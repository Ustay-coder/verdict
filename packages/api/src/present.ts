/**
 * Projects stored evaluations into public REST representations.
 * Evidence text and rating details are included only when requested; frozen rubric policy remains visible.
 */
import type { Evaluation } from "@verdict-ai/core";
/** Public view of an evaluation: strip bulky evidence text unless asked. */
export function present(ev: Evaluation, { evidence = false, ratings = true } = {}) {
  return {
    ...ev,
    rubric: { id: ev.rubric.id, name: ev.rubric.name, version: ev.rubric.version, aggregation: ev.rubric.aggregation },
    evidence: evidence ? ev.evidence : ev.evidence.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
    criteria: ratings ? ev.criteria : ev.criteria.map(({ ratings: _r, ...c }) => c),
  };
}

