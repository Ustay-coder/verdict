/**
 * Applies a rubric's `inputSchema` to a subject. Only `json` inputs carry structured fields; other inputs are
 * evidence for judges and are not checked here.
 */
import { checkInput } from "../schema/input-schema.js";
import type { InputError } from "../schema/evaluation.js";
import type { Rubric } from "../schema/rubric.js";
import type { Subject } from "../schema/subject.js";

/** Issues for every `json` input of `subject`; empty when the rubric has no `inputSchema` or all inputs match. */
export function subjectInputErrors(rubric: Rubric, subject: Subject): InputError[] {
  if (!rubric.inputSchema) return [];
  const json = subject.inputs.flatMap((input, i) => (input.type === "json" ? [{ i, data: input.data }] : []));
  if (!json.length) return [{ input: null, path: "$", message: "the rubric declares inputSchema, so the subject needs a json input" }];
  return json.flatMap(({ i, data }) => checkInput(rubric.inputSchema!, data).map((issue) => ({ input: i, ...issue })));
}
