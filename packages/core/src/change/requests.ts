/**
 * The shapes of the requests that write change tests, kept here so every surface that accepts them (today the local
 * `verdict watch` page) applies the same rules. Ids are checked as ids before they reach a store that names files by them.
 */
import { z } from "zod";
import { ValidationError } from "../engine/errors.js";

const id = z.string().regex(/^(ct|trial|rv|dsv|fu)_[0-9a-zA-Z]{1,40}$/, "not an id");
const cases = z.record(z.string(), z.array(z.unknown()));

export const ChangeRequests = {
  tests: z.object({ name: z.string().min(1).max(200), intent: z.string().max(4000).default(""), baselineVersionId: id, candidateVersionId: id.optional(), datasetVersionId: id, cases: cases.default({}) }),
  revisions: z.object({ testId: id, cases, note: z.string().max(500).optional(), baselineVersionId: id.optional() }),
  trials: z.object({ testId: id, candidateVersionId: id, reuseBaseline: z.boolean().optional(), origin: z.object({ kind: z.enum(["retry", "rerun"]), of: id }).optional() }),
  cancel: z.object({ trialId: id }),
  reverify: z.object({ trialId: id, revision: z.number().int().positive().optional() }),
  followUps: z.object({ testId: id, caseId: z.string().min(1).optional(), trialId: id.optional(), note: z.string().max(500).optional(), resolve: id.optional() }),
  versions: z.object({ rubric: z.string().min(1).max(200_000) }),
  documents: z.object({ name: z.string().max(120).optional(), documents: z.array(z.object({ name: z.string().min(1).max(200), text: z.string().min(1).max(400_000) })).min(1).max(200) }),
};
export type ChangeRequest<K extends keyof typeof ChangeRequests> = z.infer<(typeof ChangeRequests)[K]>;

/** The parsed request, or a ValidationError naming the first fields that are wrong. */
export function parseChangeRequest<K extends keyof typeof ChangeRequests>(kind: K, body: unknown): ChangeRequest<K> {
  const parsed = ChangeRequests[kind].safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data as ChangeRequest<K>;
}

/** An id taken from a URL, refused unless it is plainly one. */
export function changeId(value: string | null | undefined, what: string): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${what} is missing or not an id`);
  return parsed.data;
}
