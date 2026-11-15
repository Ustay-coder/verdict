/**
 * A script for the mock providers: fixed answers picked by the text being judged, for demos and tests that need a
 * judge to answer one document one way and the next another. A scripted answer is still the mock's — never a model's.
 * The first rule whose `when` strings all occur in the text applies; without a matching rule the mock answers as usual.
 */
import { z } from "zod";
import { parseProvider, ProviderError } from "../provider-error.js";

const ScriptAnswer = z.object({
  /** Choice criteria: option ids in order of preference; the first one the criterion has is picked. */
  choose: z.array(z.string()).min(1).optional(),
  /** Score criteria of a decision judge: the level index answered. */
  level: z.number().optional(),
  /** Binary criteria of a decision judge: P(true). */
  noul: z.number().min(0).max(1).optional(),
  /** Score criteria of an `llm` judge: the score on the criterion's scale. */
  score: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** `llm` judges only: decision models return no prose. */
  rationale: z.string().optional(),
  quotes: z.array(z.string()).optional(),
});
export type ScriptAnswer = z.infer<typeof ScriptAnswer>;

const ScriptRule = z.object({
  when: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /** Answers by criterion id. */
  answers: z.record(z.string(), ScriptAnswer).optional(),
  /** Fail the call with this message instead of answering, as a provider that is down would. */
  error: z.string().optional(),
});
export type ScriptRule = z.infer<typeof ScriptRule>;

/** The rule of `options.script` that applies to `text`; throws the rule's scripted failure. */
export function scriptedRule(options: Record<string, unknown> | undefined, text: string): ScriptRule | undefined {
  if (options?.script === undefined) return undefined;
  const rules = parseProvider("mock", z.array(ScriptRule), options.script);
  const rule = rules.find((r) => [r.when].flat().every((needle) => text.includes(needle)));
  if (rule?.error) throw new ProviderError("mock", rule.error);
  return rule;
}

/** The scripted option a criterion has; a script naming none of its options yields its first name, refused downstream. */
export function scriptedChoice(answer: ScriptAnswer, options: string[]): string | undefined {
  return answer.choose ? answer.choose.find((o) => options.includes(o)) ?? answer.choose[0] : undefined;
}
