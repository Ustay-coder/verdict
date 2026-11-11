/**
 * Public hub documents (docs/design/hub.md §9, §16). A publication is a copy of exactly what the author chose to make
 * public: one rubric version, the cases they marked public, and the numbers of the runs they chose — never the inputs,
 * outputs or ids of private cases. `buildPublication` is pure and is the only way a publication is made, so the preview
 * an author sees is the document that gets stored.
 */
import { z } from "zod";
import { GoldItem, labelCases, type LabelledCase } from "../agreement.js";
import { parseRubric, type Rubric } from "../schema/rubric.js";
import { freezeRubric, type ChangeKind } from "../versions/rubric-version.js";
import { outputContract } from "../versions/split.js";
import type { Run, RunModel } from "../versions/run.js";
import type { AgreementReport } from "../agreement.js";

/** Licences a publication may carry (SPDX ids). Cases inherit the publication's licence. */
export const PUBLICATION_LICENSES = ["CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "MIT", "Apache-2.0"] as const;
export const PUBLICATION_LIMITS = { cases: 500, caseChars: 20_000, bytes: 1_000_000, runs: 20 } as const;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug: lowercase letters, digits and dashes, up to 63 characters");

const RunModelSchema = z.object({ provider: z.string(), requested: z.string().optional(), resolved: z.string().optional(), verified: z.boolean() });
const Tally = z.object({ n: z.number().int().min(0), agreed: z.number().int().min(0) });

/** The numbers of a run as its author's CLI reports them: what a run summary keeps, and no case. */
export const ReportedRunNumbers = z.object({
  id: z.string(), rubricVersionId: z.string(), datasetVersionId: z.string(), status: z.enum(["completed", "partial", "failed"]), startedAt: z.string(),
  fingerprint: z.object({
    judgmentHash: z.string(), policyHash: z.string(), bindingHash: z.string(), questionsHash: z.string().nullable(), adapterVersion: z.string(),
    casesHash: z.string(), labelsHash: z.string(), models: z.array(RunModelSchema), scoring: z.string(),
  }),
  counts: z.object({ cases: z.number(), completed: z.number(), pendingHuman: z.number(), failed: z.number(), invalidInput: z.number(), labelled: z.number() }),
});

/** Agreement with the labels, in counts. */
export const ReportedAgreement = z.object({
  decided: z.number().int().min(0), agreed: z.number().int().min(0),
  criteria: z.record(z.string(), Tally.extend({ askedHuman: z.number().int().min(0) })),
  splits: z.record(z.string(), Tally.extend({ items: z.number(), decided: z.number(), agreed: z.number() }).omit({ n: true })).optional(),
  labelSources: z.record(z.string(), z.number()).optional(),
});

/** A run as the author's CLI reports it. Only the fields below are read; anything else is dropped. */
const ReportedRun = z.object({ run: ReportedRunNumbers.extend({ cases: z.array(z.object({ caseId: z.string() })) }), report: ReportedAgreement });

export const PublicationRequest = z.object({
  slug: Slug,
  version: z.object({ id: z.string(), rubric: z.unknown(), parentVersionId: z.string().optional(), fork: z.object({ note: z.string().optional(), changeKinds: z.array(z.string()) }).optional() }),
  license: z.string(),
  title: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  domain: z.string().max(60).optional(),
  locale: z.string().max(35).optional(),
  sources: z.array(z.string().max(500)).max(20).default([]),
  note: z.string().max(2000).optional(),
  cases: z.array(GoldItem).max(PUBLICATION_LIMITS.cases).default([]),
  runs: z.array(ReportedRun).max(PUBLICATION_LIMITS.runs).default([]),
});
export type PublicationRequest = z.input<typeof PublicationRequest>;

/** Numbers of one run, as reported by the author. Never contains a case id, an input or an output. */
export interface PublicRunSummary {
  runId: string;
  /** The hub cannot re-run private cases; every run is reported by its author. */
  origin: "author_reported";
  rubricVersionId: string; datasetVersionId: string; status: string; startedAt: string;
  fingerprint: { judgmentHash: string; policyHash: string; bindingHash: string; questionsHash: string | null; adapterVersion: string; casesHash: string; labelsHash: string; models: RunModel[]; scoring: string };
  counts: { cases: number; completed: number; pendingHuman: number; failed: number; invalidInput: number; labelled: number };
  agreement: { decided: number; agreed: number; criteria: Record<string, { n: number; agreed: number; askedHuman: number }> };
  splits?: Record<string, { items: number; decided: number; agreed: number }>;
  labelSources?: Record<string, number>;
  /** True when every case of the run is among the publication's public cases, so anyone can repeat it. */
  casesPublic: boolean;
}

export type PublicCase = Pick<LabelledCase, "id" | "name" | "inputs" | "labelSource" | "split" | "kind" | "note"> & { expected: Record<string, number | string | boolean> };

export interface Publication {
  id: string;
  /** Public handle of the publisher; `ref` = `owner/slug`. */
  owner: string; slug: string; ref: string;
  /** Tenant that published it: the only one who may withdraw it. Not shown publicly. */
  tenantId?: string;
  title: string; description?: string; domain?: string; locale?: string;
  judgmentType: "score" | "noul" | "choice";
  license: string; sources: string[]; note?: string;
  version: { id: string; rubric: Rubric; judgmentHash: string; policyHash: string; bindingHash: string; contentHash: string; changeKinds?: ChangeKind[]; forkNote?: string };
  /** A published parent is linked; an unpublished one is only said to exist. */
  parent?: { public: true; versionId: string; publicationId: string; ref: string } | { public: false };
  cases: PublicCase[];
  runs: PublicRunSummary[];
  createdAt: string;
  withdrawnAt?: string;
  /** Set when the hub's operators took the publication down (it is then also withdrawn); the reason is shown publicly. */
  takedown?: { reason: string; at: string };
}

export interface PublicationIssue { path: string; message: string }
export interface PublicationResult { ok: boolean; issues: PublicationIssue[]; warnings: PublicationIssue[]; publication?: Omit<Publication, "id" | "createdAt"> }

export interface PublicationContext {
  owner: string;
  tenantId?: string;
  /** Looks up a live publication of a version, to link a published parent. */
  findParent?: (versionId: string) => Promise<{ id: string; ref: string } | undefined>;
}

/** Validates a request and builds the public document. Never throws for a bad request: issues explain it. */
export async function buildPublication(input: unknown, ctx: PublicationContext): Promise<PublicationResult> {
  const parsed = PublicationRequest.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => ({ path: i.path.join(".") || "<root>", message: i.message })));
  const req = parsed.data;
  let rubric: Rubric;
  try { rubric = parseRubric(req.version.rubric); }
  catch (e) { return fail([{ path: "version.rubric", message: (e as Error).message }]); }
  const frozen = await freezeRubric(rubric);
  const cases = labelCases(req.cases);
  const issues = [...versionIssues(req, rubric, frozen.id), ...caseIssues(cases), ...runIssues(req, frozen.id)];
  if (issues.length) return fail(issues);
  const criterion = rubric.criteria[0]!;
  const caseIds = new Set(cases.map((c) => c.id));
  const parentLink = req.version.parentVersionId ? await ctx.findParent?.(req.version.parentVersionId) : undefined;
  return {
    ok: true, issues: [], warnings: warnings(cases),
    publication: {
      owner: ctx.owner, slug: req.slug, ref: `${ctx.owner}/${req.slug}`, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      title: req.title ?? rubric.name, ...optional({ description: req.description ?? rubric.description, domain: req.domain ?? meta(rubric, "domain"), locale: req.locale ?? meta(rubric, "locale"), note: req.note }),
      judgmentType: outputContract(rubric, criterion).type, license: req.license, sources: req.sources,
      version: {
        id: frozen.id, rubric, judgmentHash: frozen.judgmentHash, policyHash: frozen.policyHash, bindingHash: frozen.bindingHash, contentHash: frozen.contentHash,
        ...(req.version.fork ? { changeKinds: req.version.fork.changeKinds as ChangeKind[], ...(req.version.fork.note ? { forkNote: req.version.fork.note } : {}) } : {}),
      },
      ...(req.version.parentVersionId ? { parent: parentLink ? { public: true as const, versionId: req.version.parentVersionId, publicationId: parentLink.id, ref: parentLink.ref } : { public: false as const } } : {}),
      cases: cases.map(publicCase),
      runs: req.runs.map((r) => runSummary(r, caseIds)),
    },
  };
}

const fail = (issues: PublicationIssue[]): PublicationResult => ({ ok: false, issues, warnings: [] });

function versionIssues(req: z.infer<typeof PublicationRequest>, rubric: Rubric, frozenId: string): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  if (frozenId !== req.version.id) issues.push({ path: "version.id", message: `the rubric freezes to ${frozenId}, not ${req.version.id}` });
  if (rubric.criteria.length !== 1) issues.push({ path: "version.rubric.criteria", message: `the hub publishes single-question cards: exactly 1 criterion, got ${rubric.criteria.length}` });
  if (!(PUBLICATION_LICENSES as readonly string[]).includes(req.license)) issues.push({ path: "license", message: `choose a licence: ${PUBLICATION_LICENSES.join(", ")}` });
  rubric.criteria.forEach((c, i) => {
    if (outputContract(rubric, c).type === "noul" && c.threshold === undefined) issues.push({ path: `version.rubric.criteria.${i}.threshold`, message: "a yes/no criterion needs an explicit threshold to be published" });
  });
  for (const [where, url] of baseUrls(rubric)) issues.push({ path: where, message: `remove baseUrl (${url}) before publishing: endpoints, possibly internal, would become public` });
  return issues;
}

function caseIssues(cases: LabelledCase[]): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  cases.forEach((c, i) => {
    if (c.visibility !== "public") issues.push({ path: `cases.${i}.visibility`, message: `case ${c.id} is not marked public; set visibility: public to publish it` });
    c.inputs.forEach((input, j) => {
      if (input.type !== "text" && input.type !== "json" && input.type !== "url") issues.push({ path: `cases.${i}.inputs.${j}`, message: `${input.type} inputs cannot be published (text, json and url can)` });
    });
    if (JSON.stringify(c.inputs).length > PUBLICATION_LIMITS.caseChars) issues.push({ path: `cases.${i}.inputs`, message: `case ${c.id} is over ${PUBLICATION_LIMITS.caseChars} characters` });
  });
  return issues;
}

function runIssues(req: z.infer<typeof PublicationRequest>, versionId: string): PublicationIssue[] {
  return req.runs.flatMap((r, i) => r.run.rubricVersionId === versionId ? [] : [{ path: `runs.${i}.run.rubricVersionId`, message: `run ${r.run.id} is of ${r.run.rubricVersionId}; only runs of the published version can be attached` }]);
}

// Heuristics only: they ask the author to look again, they do not prove anything is personal data.
const PERSONAL = [
  { name: "an e-mail address", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: "a phone number", re: /(?:\+?\d{1,3}[ -]?)?(?:0\d{1,2}|\(\d{2,3}\))[ -]?\d{3,4}[ -]?\d{4}/ },
  { name: "a resident registration number", re: /\b\d{6}-?[1-4]\d{6}\b/ },
];

function warnings(cases: LabelledCase[]): PublicationIssue[] {
  const out: PublicationIssue[] = [];
  cases.forEach((c, i) => {
    const text = JSON.stringify(c.inputs);
    for (const p of PERSONAL) if (p.re.test(text)) out.push({ path: `cases.${i}`, message: `case ${c.id} looks like it contains ${p.name}; make sure it may be public` });
    if (!c.labelSource || c.labelSource === "ai_unreviewed" || c.labelSource === "unknown") out.push({ path: `cases.${i}.labelSource`, message: `case ${c.id}: its label is shown as ${c.labelSource ?? "unknown"} (not reviewed by a person)` });
  });
  return out;
}

function publicCase(c: LabelledCase): PublicCase {
  return { id: c.id, name: c.name, inputs: c.inputs, expected: c.human.criteria ?? {}, ...optional({ labelSource: c.labelSource, split: c.split, kind: c.kind, note: c.note }) };
}

function runSummary(r: z.infer<typeof ReportedRun>, publicIds: Set<string>): PublicRunSummary {
  return { ...runNumbers(r.run, r.report), casesPublic: r.run.cases.length > 0 && r.run.cases.every((c) => publicIds.has(c.caseId)) };
}

/** A run's summary from what was reported: numbers only, marked as reported by its author. */
export function runNumbers(run: z.infer<typeof ReportedRunNumbers>, report: z.infer<typeof ReportedAgreement>): Omit<PublicRunSummary, "casesPublic"> {
  return {
    runId: run.id, origin: "author_reported", rubricVersionId: run.rubricVersionId, datasetVersionId: run.datasetVersionId, status: run.status, startedAt: run.startedAt,
    fingerprint: run.fingerprint, counts: run.counts,
    agreement: { decided: report.decided, agreed: report.agreed, criteria: Object.fromEntries(Object.entries(report.criteria).map(([id, t]) => [id, { n: t.n, agreed: t.agreed, askedHuman: t.askedHuman }])) },
    ...(report.splits ? { splits: Object.fromEntries(Object.entries(report.splits).map(([k, t]) => [k, { items: t.items, decided: t.decided, agreed: t.agreed }])) } : {}),
    ...(report.labelSources ? { labelSources: report.labelSources } : {}),
  };
}

/**
 * What a client sends about a run: its conditions and counts, copied field by field. The run record and the agreement
 * report hold much more — every case's id, name, labels and evaluation — and none of that is read here.
 */
export function reportedNumbers(run: Run, report: AgreementReport): { run: z.input<typeof ReportedRunNumbers>; report: z.input<typeof ReportedAgreement> } {
  const model = (m: RunModel): RunModel => ({ provider: m.provider, verified: m.verified, ...(m.requested === undefined ? {} : { requested: m.requested }), ...(m.resolved === undefined ? {} : { resolved: m.resolved }) });
  return {
    run: {
      id: run.id, rubricVersionId: run.rubricVersionId, datasetVersionId: run.datasetVersionId, status: run.status, startedAt: run.startedAt,
      fingerprint: { ...run.fingerprint, models: run.fingerprint.models.map(model) }, counts: { ...run.counts },
    },
    report: {
      decided: report.decided, agreed: report.agreed,
      criteria: Object.fromEntries(Object.entries(report.criteria).map(([id, t]) => [id, { n: t.n, agreed: t.agreed, askedHuman: t.askedHuman }])),
      splits: Object.fromEntries(Object.entries(report.splits).map(([k, t]) => [k, { items: t.items, decided: t.decided, agreed: t.agreed }])),
      labelSources: { ...report.labelSources },
    },
  };
}

/**
 * A run as a publication request carries it: its numbers, and which of its cases are among the published ones. The
 * hub marks a run repeatable only when every case it ran is public, so it needs one entry per case — but a case that
 * is not being published is sent as a random stand-in, never by its id.
 */
export function publicationRun(run: Run, report: AgreementReport, publishedCaseIds: Iterable<string>): NonNullable<PublicationRequest["runs"]>[number] {
  const published = new Set(publishedCaseIds);
  const numbers = reportedNumbers(run, report);
  return { run: { ...numbers.run, cases: run.cases.map((c) => ({ caseId: published.has(c.caseId) ? c.caseId : `withheld_${crypto.randomUUID()}` })) }, report: numbers.report };
}

function baseUrls(rubric: Rubric): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (spec: unknown, where: string) => {
    if (!spec || typeof spec !== "object") return;
    const s = spec as { baseUrl?: unknown; judges?: unknown[] };
    if (typeof s.baseUrl === "string") found.push([`${where}.baseUrl`, s.baseUrl]);
    s.judges?.forEach((j, i) => visit(j, `${where}.judges.${i}`));
  };
  visit(rubric.defaultJudge, "version.rubric.defaultJudge");
  if (rubric.checksJudge) visit(rubric.checksJudge, "version.rubric.checksJudge");
  for (const [name, spec] of Object.entries(rubric.judges)) visit(spec, `version.rubric.judges.${name}`);
  rubric.criteria.forEach((c, i) => [c.judge].flat().forEach((j, k) => visit(j, `version.rubric.criteria.${i}.judge.${k}`)));
  return found;
}

function meta(rubric: Rubric, key: string): string | undefined {
  const value = rubric.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function optional<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}

