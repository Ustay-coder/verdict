/**
 * Registers `verdict check`: run a rubric over a human-labelled gold set and print how often Verdict agreed.
 * The check needs local files and the local engine; a remote API cannot read the gold set.
 */
import { checkAgainstHumans, parseGoldSet, type AgreementItem, type AgreementReport } from "@verdict-ai/core";
import { Command } from "commander";
import { dirname, resolve } from "node:path";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { readText } from "../files.js";
import { loadCommandRubric } from "../remote.js";
import { addServerRefOptions, serverRubric, type ServerRefOptions } from "../control/server-ref.js";
import type { HubDependencies } from "../hub/deps.js";
import { guardRubric } from "../versions/guard.js";

type CheckDependencies = CommandDependencies & { loadRubric: typeof loadCommandRubric; readText: typeof readText; guard?: typeof guardRubric; server?: HubDependencies };

/** Registers the check command; handler failures propagate to the CLI failure handler. */
export function registerCheck(program: Command, deps: CheckDependencies = { ...commandDefaults, loadRubric: loadCommandRubric, readText }) {
  const command = program.command("check").description("run a rubric over a human-labelled gold set and report agreement with the humans")
    .requiredOption("-r, --rubric <ref>", "rubric file, stored rubric id, or a name on your team's server: <name> with --env, <name>@latest, <name>@rv_…").requiredOption("-g, --gold <file>", "JSON array or JSON lines of {id?, name, inputs, expected?: {criterion: label}, human?: {passed?, criteria?}, labelSource?, split?}")
    .option("--json").option("--mock", "use mock providers (no API calls)")
    .option("--strict", "fail when the rubric file no longer matches verdict.lock or its locked run").option("--lock <path>", "lock file", "verdict.lock");
  addServerRefOptions(command)
    .action(async (o: CheckOptions) => {
      // The gold set lives on this machine, so a configured remote API cannot run the check.
      if (deps.remote()) return deps.fail("check runs on the local engine; unset VERDICT_API_URL");
      const goldPath = resolve(o.gold);
      const items = parseGoldSet(await deps.readText(goldPath), dirname(goldPath));
      const guard = await (deps.guard ?? guardRubric)(o.rubric, o);
      const engine = deps.engine();
      const report = await checkAgainstHumans(engine, (await serverRubric(o.rubric, o, deps.server)) ?? (await deps.loadRubric(o.rubric, o.mock)), items);
      if (o.json) deps.out(JSON.stringify(report, null, 2));
      else for (const line of renderAgreement(report)) deps.out(line);
      const evaluations = await Promise.all(report.results.map((r) => engine.store.getEvaluation(r.evaluationId)));
      await guard.after(evaluations.filter((e) => e !== undefined));
    });
}

const percent = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** Human-readable summary: the total, each criterion, then each subject Verdict judged differently. */
export function renderAgreement(report: AgreementReport): string[] {
  const invalid = report.invalidInput ? ` (invalid input: ${report.invalidInput})` : "";
  const lines = [`${report.rubric}: ${report.agreed}/${report.decided} agree with the humans (${percent(report.agreement)}); asked a human: ${report.askedHuman}; failed: ${report.failed}${invalid}`];
  for (const [id, c] of Object.entries(report.criteria)) lines.push(`  ${id.padEnd(20)} ${c.agreed}/${c.n} (${percent(c.agreement)})${c.askedHuman ? `, asked a human: ${c.askedHuman}` : ""}`);
  lines.push(...provenanceLines(report));
  for (const r of report.results) lines.push(...disagreementLines(r));
  for (const r of report.results.filter((x) => x.inputErrors)) lines.push(`  ! ${r.name}: invalid input — ${r.inputErrors!.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  return lines;
}

// One line for a disagreeing overall verdict, then one per disagreeing criterion.
function disagreementLines(r: AgreementItem): string[] {
  const preview = r.preview ? ` — ${r.preview.replace(/\s+/g, " ").slice(0, 90)}` : "";
  const lines = r.agrees === false ? [`  ✗ ${r.name}: human ${r.human.passed ? "pass" : "fail"}, Verdict ${r.passed ? "pass" : "fail"}${preview}`] : [];
  for (const [id, c] of Object.entries(r.criteria)) if (c.agrees === false) lines.push(`  ✗ ${r.name} · ${id}: human ${c.human}, Verdict ${c.verdict}${preview}`);
  return lines;
}

// Splits and label sources only earn a line when the gold set uses them.
function provenanceLines(report: AgreementReport): string[] {
  const lines: string[] = [];
  const splits = Object.entries(report.splits);
  if (splits.some(([name]) => name !== "unspecified")) lines.push(`  splits: ${splits.map(([name, t]) => `${name} ${t.agreed}/${t.decided} (${percent(t.agreement)}) of ${t.items}`).join("; ")}`);
  const sources = Object.entries(report.labelSources);
  if (sources.some(([name]) => name !== "unspecified")) lines.push(`  labels: ${sources.map(([name, n]) => `${name} ${n}`).join(", ")}`);
  return lines;
}

interface CheckOptions extends ServerRefOptions { rubric: string; gold: string; json?: boolean; mock?: boolean; strict?: boolean; lock?: string }
