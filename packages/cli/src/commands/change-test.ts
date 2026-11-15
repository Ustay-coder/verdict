/**
 * Registers `verdict change-test`: keep a test of what a rubric change should do to the same documents, run a
 * candidate version against it, and check the result against expectations written beforehand
 * (docs/design/change-tests.md). Everything runs on the local engine; `verdict watch` shows the same records.
 */
import {
  createChangeTest, createDatasetVersion, createTrial, currentRevision, executeTrial, hasChangeTests, observeTrial, parseGoldSet, reverifyTrial, reviseExpectations, scoreChange,
  seedChangeDemo, trialConditions, ValidationError, type CaseVerificationStatus, type ChangeTest, type ChangeWorkbench, type DatasetVersion, type ScoreChange, type Trial,
  type TrialConditions,
} from "@verdict-ai/core";
import { Command } from "commander";
import { basename, dirname, resolve } from "node:path";
import YAML from "yaml";

import { resolveVersion, versionDefaults, workspace, type VersionDependencies, type Workspace } from "../versions/workspace.js";

const WATCH = "http://127.0.0.1:4600/change-tests";
const GATES: CaseVerificationStatus[] = ["unmet", "needs_review", "incomparable", "unverified"];
const MARK: Record<string, string> = { met: "✓ met", unmet: "✗ not met", needs_review: "? needs review", incomparable: "≠ not comparable", unverified: "○ not verified" };

interface Common { lock?: string; mock?: boolean; json?: boolean }

function bench(deps: VersionDependencies, o: Common): Workspace & { change: ChangeWorkbench } {
  const ws = workspace(deps, o);
  if (!hasChangeTests(ws.engine.store)) throw new ValidationError("the configured store cannot keep change tests");
  return { ...ws, change: ws.engine.store as unknown as ChangeWorkbench };
}

/** A cases file as a document set. Unlike a gold file, a case needs no label: a change test brings its own expectations. */
async function resolveDocuments(ws: Workspace & { change: ChangeWorkbench }, path: string): Promise<DatasetVersion> {
  const text = (await ws.deps.readText(path)).trim();
  const raw: unknown[] = text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const unlabelled = raw.map((item) => (item && typeof item === "object" && !("expected" in item) && !("human" in item) ? { ...item, human: {} } : item));
  const dataset = await createDatasetVersion(parseGoldSet(JSON.stringify(unlabelled), dirname(resolve(path))), { name: basename(path), readFile: ws.deps.readBytes });
  if (!(await ws.change.getDatasetVersion(dataset.id))) await ws.change.putDatasetVersion(dataset);
  return (await ws.change.getDatasetVersion(dataset.id)) ?? dataset;
}

interface ExpectFile { name?: string; intent?: string; mapping?: Record<string, string | null>; cases?: Record<string, unknown[]> }

async function readExpectations(ws: Workspace, path: string | undefined): Promise<ExpectFile> {
  if (!path) return {};
  const parsed = YAML.parse(await ws.deps.readText(path)) as ExpectFile | null;
  if (!parsed || typeof parsed !== "object" || (parsed.cases !== undefined && typeof parsed.cases !== "object")) throw new ValidationError(`${path}: expected a mapping with \`cases: { <case id>: [expectations] }\``);
  return parsed;
}

async function findTest(ws: { change: ChangeWorkbench }, ref: string): Promise<ChangeTest> {
  const test = ref.startsWith("ct_") ? await ws.change.getChangeTest(ref) : (await ws.change.listChangeTests({ limit: 500 })).find((t) => t.name === ref);
  if (!test) throw new ValidationError(`no change test ${ref} in this data directory (see \`verdict change-test list\`)`);
  return test;
}

const pts = (n: number) => String(Math.round(n * 100) / 100);

const moved = (change: ScoreChange) => (change.delta === null
  ? `${change.base === null ? "—" : pts(change.base)} → — (${change.reason})`
  : `${pts(change.base!)} → ${pts(change.head!)} (${change.delta > 0 ? "+" : ""}${pts(change.delta)})`);

function conditionLines(conditions: TrialConditions): string[] {
  const same = conditions.rubricOnly ? "conditions: the same on both sides; differences come from the rubric" : `conditions: ${conditions.differences.every((d) => d.field === "modelsUnverified") ? "could not be confirmed the same" : "NOT only the rubric differs"} — ${conditions.differences.map((d) => d.note).join("; ")}`;
  return conditions.mock ? [same, `judge: ${conditions.scripted ? "scripted mock" : "mock"} — not a model's judgement`] : [same];
}

/** A trial as lines for a terminal: the conditions, one line per document with its change, and why each expectation held or not. */
export async function renderTrial(store: ChangeWorkbench, test: ChangeTest, trial: Trial): Promise<string[]> {
  const seen = await observeTrial(store, test, trial);
  const verification = trial.verifications.at(-1);
  const ctx = { base: seen.baseline.rubric, head: seen.candidate.rubric, ...(test.mapping ? { mapping: test.mapping } : {}) };
  const single = seen.candidate.rubric.criteria.length === 1 ? seen.candidate.rubric.criteria[0]!.id : undefined;
  const lines = [
    `trial ${trial.id}: ${trial.status} · ${trial.baseline.versionId} → ${trial.candidate.versionId} · ${seen.cases.length} documents · expectations revision ${verification?.revision ?? trial.revision}`,
    ...conditionLines(await trialConditions(seen)),
  ];
  for (const c of seen.cases) {
    const result = verification?.cases[c.caseId];
    lines.push(`  ${(MARK[result?.status ?? ""] ?? "… pending").padEnd(18)} ${c.name}   ${single ?? "total"} ${moved(scoreChange(ctx, { base: c.base, head: c.head }, single))}`);
    for (const e of result?.expectations ?? []) lines.push(`      ${MARK[e.status]}: ${e.message}${e.caveat ? ` [note: ${e.caveat}]` : ""}`);
  }
  const v = verification?.summary.verification;
  if (v) lines.push(`${v.met} of ${v.verifiable} verifiable cases met; ${verification.summary.cases} in all (not comparable ${v.incomparable}, needs review ${v.needs_review}, without expectations ${v.unverified})`);
  return lines;
}

function tripped(trial: Trial, spec: string | undefined): string[] {
  const gates = (spec ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  const unknown = gates.filter((g) => !(GATES as string[]).includes(g));
  if (unknown.length) throw new ValidationError(`unknown --fail-on status ${unknown.join(", ")}; use ${GATES.join(", ")}`);
  const v = trial.verifications.at(-1)?.summary.verification;
  return v ? gates.filter((g) => v[g as CaseVerificationStatus] > 0).map((g) => `${v[g as CaseVerificationStatus]} ${g}`) : [];
}

async function show(ws: Workspace & { change: ChangeWorkbench }, o: Common & { failOn?: string }, test: ChangeTest, trial: Trial) {
  if (o.json) ws.deps.out(JSON.stringify({ test: { id: test.id, name: test.name }, trial }, null, 2));
  else {
    for (const line of await renderTrial(ws.change, test, trial)) ws.deps.out(line);
    ws.deps.warn(`see it in \`verdict watch\`: ${WATCH}?trial=${trial.id}`);
  }
  const failed = tripped(trial, o.failOn);
  if (failed.length) { ws.deps.warn(`change-test: ${failed.join(", ")} (--fail-on ${o.failOn})`); ws.deps.exitCode(1); }
}

/** Registers the change-test commands; failures reach the CLI failure handler, a tripped gate only sets the exit code. */
export function registerChangeTest(program: Command, deps: VersionDependencies = versionDefaults) {
  const group = program.command("change-test").description("check what a rubric change does to the same documents, against expectations written beforehand (local engine)");
  for (const register of [registerDemo, registerCreate, registerRun, registerRevise, registerList]) register(group, deps);
}

const common = (c: Command) => c.option("--lock <path>", "lock file", "verdict.lock").option("--json");

function registerDemo(group: Command, deps: VersionDependencies) {
  common(group.command("demo").description("create two demo tests from invented documents and a scripted mock judge (no model is called), and run them"))
    .action(async (o: Common) => {
      const ws = bench(deps, o);
      const { tests } = await seedChangeDemo(ws.engine, ws.change);
      if (o.json) return deps.out(JSON.stringify(tests.map((t) => ({ testId: t.test.id, trialId: t.trial.id, created: t.created })), null, 2));
      for (const t of tests) {
        deps.out(`${t.created ? "created" : "already there"}: ${t.test.name}  (${t.test.id})`);
        for (const line of await renderTrial(ws.change, t.test, t.trial)) deps.out(line);
        deps.out("");
      }
      deps.out(`open them with \`verdict watch\`: ${WATCH}`);
    });
}

function registerCreate(group: Command, deps: VersionDependencies) {
  common(group.command("create").description("keep a new change test: a baseline version, a set of documents and what you expect of each"))
    .requiredOption("--base <ref>", "baseline: a rubric file or rv_… id; changes are measured from it").option("--head <ref>", "the candidate you have in mind: a rubric file or rv_… id")
    .requiredOption("-d, --data <file>", "documents: JSON lines of { id?, name, inputs }; labels are not needed").option("--expect <file>", "YAML or JSON: name, intent, mapping and cases: { <case id>: [expectations] }")
    .option("--name <text>", "name of the test").option("--intent <text>", "what the change is meant to do, for people").option("--mock", "use mock providers for rubric files and versions")
    .action(async (o: Common & { base: string; head?: string; data: string; expect?: string; name?: string; intent?: string }) => {
      const ws = bench(deps, o);
      const file = await readExpectations(ws, o.expect);
      const [baseline, candidate, dataset] = await Promise.all([resolveVersion(ws, o.base), o.head ? resolveVersion(ws, o.head) : undefined, resolveDocuments(ws, o.data)]);
      const test = await createChangeTest(ws.change, {
        name: o.name ?? file.name ?? basename(o.data), intent: o.intent ?? file.intent ?? "", baselineVersionId: baseline.version.id, ...(candidate ? { candidateVersionId: candidate.version.id } : {}),
        datasetVersionId: dataset.id, ...(file.mapping ? { mapping: file.mapping } : {}), cases: file.cases ?? {},
      });
      if (o.json) return deps.out(JSON.stringify(test, null, 2));
      const written = Object.values(currentRevision(test).cases).flat().length;
      deps.out(`change test ${test.id}: ${test.name} — ${dataset.cases.length} documents, ${written} expectation${written === 1 ? "" : "s"}, baseline ${baseline.version.id}`);
      deps.out(`run it: verdict change-test run ${test.id}${o.head ? "" : " --head <candidate>"}    or open ${WATCH}?test=${test.id}`);
    });
}

function registerRun(group: Command, deps: VersionDependencies) {
  common(group.command("run <test>").description("evaluate the documents under the baseline and a candidate, and check the result against the test"))
    .option("--head <ref>", "candidate: a rubric file or rv_… id (default: the one the test was written with)").option("--rerun-baseline", "evaluate the baseline again instead of showing stored results")
    .option("--fail-on <statuses>", `exit 1 when any case is: ${GATES.join(", ")}`).option("--mock", "use mock providers for rubric files and versions")
    .action(async (ref: string, o: Common & { head?: string; rerunBaseline?: boolean; failOn?: string }) => {
      const ws = bench(deps, o);
      tripped({ verifications: [] } as unknown as Trial, o.failOn);
      const test = await findTest(ws, ref);
      const candidateId = o.head ? (await resolveVersion(ws, o.head)).version.id : test.candidateVersionId;
      if (!candidateId) throw new ValidationError("this test names no candidate; pass --head");
      const { trial, existing } = await createTrial(ws.change, test.id, candidateId, { reuseBaseline: !o.rerunBaseline });
      if (existing) throw new ValidationError(`trial ${trial.id} of this test and candidate is already ${trial.status}; wait for it or cancel it in \`verdict watch\``);
      const reusedCount = trial.baseline.cases.filter((c) => c.reusedFrom).length;
      if (reusedCount) deps.warn(`showing ${reusedCount} stored baseline result${reusedCount === 1 ? "" : "s"} again; --rerun-baseline to evaluate them again`);
      await show(ws, o, test, await executeTrial(ws.engine, ws.change, trial.id, { runner: `pid:${process.pid}` }));
    });
}

function registerRevise(group: Command, deps: VersionDependencies) {
  common(group.command("expect <test>").description("save new expectations as the next revision; earlier revisions and their verifications are kept"))
    .requiredOption("--file <file>", "YAML or JSON with cases: { <case id>: [expectations] }").option("--base <ref>", "move the baseline to this version (deltas are measured from it)").option("--note <text>")
    .action(async (ref: string, o: Common & { file: string; base?: string; note?: string }) => {
      const ws = bench(deps, o);
      const test = await findTest(ws, ref);
      const file = await readExpectations(ws, o.file);
      const baselineVersionId = o.base ? (await resolveVersion(ws, o.base)).version.id : undefined;
      const next = await reviseExpectations(ws.change, test.id, { cases: file.cases ?? {}, ...(baselineVersionId ? { baselineVersionId } : {}), ...(o.note ? { note: o.note } : {}) });
      deps.out(o.json ? JSON.stringify(next, null, 2) : `change test ${test.id}: revision ${currentRevision(next).revision} saved; \`verdict change-test reverify <trial>\` checks a stored trial against it without calling a judge`);
    });

  common(group.command("reverify <trial>").description("check a stored trial against the newest expectations; no judge is called and earlier verifications are kept"))
    .option("--revision <n>", "the expectation revision to check against").option("--fail-on <statuses>", `exit 1 when any case is: ${GATES.join(", ")}`)
    .action(async (trialId: string, o: Common & { revision?: string; failOn?: string }) => {
      const ws = bench(deps, o);
      const trial = await reverifyTrial(ws.change, trialId, o.revision ? { revision: Number(o.revision) } : {});
      await show(ws, o, await findTest(ws, trial.testId), trial);
    });
}

function registerList(group: Command, deps: VersionDependencies) {
  common(group.command("list").description("list the change tests kept in this data directory"))
    .action(async (o: Common) => {
      const ws = bench(deps, o);
      const tests = await ws.change.listChangeTests({ limit: 500 });
      if (o.json) return deps.out(JSON.stringify(tests.map((t) => ({ id: t.id, name: t.name, demo: !!t.demo, revision: currentRevision(t).revision, createdAt: t.createdAt })), null, 2));
      if (!tests.length) return deps.out("no change tests yet: `verdict change-test demo` makes two to look at");
      for (const t of tests) {
        const latest = (await ws.change.listTrials({ testId: t.id, limit: 1 }))[0];
        const v = latest?.verifications.at(-1)?.summary.verification;
        deps.out(`${t.id}  ${t.name}${t.demo ? " [demo]" : ""} — revision ${currentRevision(t).revision}; ${latest ? `latest trial ${latest.id} ${latest.status}${v ? `, ${v.met} of ${v.verifiable} verifiable cases met` : ""}` : "no trial yet"}`);
      }
    });
}
