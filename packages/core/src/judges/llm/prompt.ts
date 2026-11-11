/**
 * Renders rubric instructions for generative judges without performing I/O.
 * Scale labels and anchors must remain aligned so model scores stay in criterion units.
 */
import type { Scale } from "../../schema/rubric.js";
import { type JudgeContext } from "../types.js";

/** Describes legal score values for prompting; expects a validated scale. */
export function describeScale(scale: Scale): string {
  switch (scale.type) {
    case "numeric": return `an integer or decimal between ${scale.min} and ${scale.max}${scale.step ? ` in steps of ${scale.step}` : ""} (${scale.min} = worst, ${scale.max} = best)`;
    case "binary": return `0 or 1 (0 = ${scale.labels?.[0] ?? "fail"}, 1 = ${scale.labels?.[1] ?? "pass"})`;
    case "ordinal": {
      const vals = scale.values ?? scale.labels.map((_, i) => i);
      return `one of: ${scale.labels.map((l, i) => `${vals[i]} = "${l}"`).join(", ")} (ordered worst to best)`;
    }
  }
}

/** Renders rubric context and criterion anchors; does not fetch evidence or call providers. */
export function buildSystemPrompt(ctx: JudgeContext, extra?: string): string {
  const { rubric, criterion, scale } = ctx;
  const anchors = criterion.anchors
    ? Object.entries(criterion.anchors).map(([k, v]) => `  - ${k}: ${v}`).join("\n")
    : undefined;
  const lang = rubric.language ? `Write the rationale in language "${rubric.language}".` : "Write the rationale in the same language as the inputs.";
  return [
    `You are a rigorous, impartial evaluator. You score ONE criterion of a rubric based strictly on the provided inputs.`,
    ``,
    `# Rubric: ${rubric.name}${rubric.version ? ` (v${rubric.version})` : ""}`,
    rubric.description ? rubric.description : undefined,
    rubric.context ? `\n## Evaluation context\n${rubric.context}` : undefined,
    ``,
    `# Criterion: ${criterion.name} (id: ${criterion.id})`,
    criterion.description ?? "",
    ``,
    `## Scale`,
    criterion.choices ? `Return the chosen option id in choice. Options: ${JSON.stringify(criterion.choices)}. Set score to 0; Verdict maps the choice to its value.` : `Score must be ${describeScale(scale)}.`,
    anchors ? `\n## Anchors (what each level looks like)\n${anchors}` : undefined,
    ``,
    `## Rules`,
    `- Judge only this criterion. Ignore qualities covered by other criteria.`,
    `- Base the score on evidence in the inputs. Do not reward claims without support; do not penalize for missing information that the criterion does not require.`,
    `- If the inputs do not contain enough information to assess the criterion, give the lowest reasonable score and say so in the rationale with low confidence.`,
    `- Quote verbatim passages that drove the score.`,
    `- ${lang}`,
    extra ? `\n## Additional instructions\n${extra}` : undefined,
  ].filter((l) => l !== undefined).join("\n");
}

