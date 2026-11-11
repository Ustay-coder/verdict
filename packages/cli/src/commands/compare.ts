import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { ValidationError, type Rubric, type Subject } from "@verdict-ai/core";
import type { BatchResult } from "@verdict-ai/sdk";
import { Command } from "commander";

import { parseInput } from "../inputs.js";
import { loadCommandRubric } from "../remote.js";
import { fmt } from "../report.js";
import { guardRubric } from "../versions/guard.js";

/** Registers compare operations; handler failures propagate to the transport error boundary. */
export function registerCompare(program: Command, deps: CommandDependencies & { loadRubric: typeof loadCommandRubric; guard?: typeof guardRubric } = { ...commandDefaults, loadRubric: loadCommandRubric }) {
  program
    .command("compare")
    .description("rank several subjects against one rubric (each -s is one subject: name=input[,input...])")
    .requiredOption("-r, --rubric <fileOrId>")
    .requiredOption("-s, --subject <subject...>", "name=input[,input...]")
    .option("--json")
    .option("--idempotency-key <key>")
    .option("--mock")
    .option("--strict", "fail when the rubric file no longer matches verdict.lock or its locked run")
    .option("--lock <path>", "lock file", "verdict.lock")
    .action(async (o: CompareOptions) => {
      const guard = await (deps.guard ?? guardRubric)(o.rubric, o);
      const rubric = await deps.loadRubric(o.rubric, o.mock);
      const subjects = o.subject.map(parseSubject);
      const result = await runComparison(rubric, subjects, deps, o.idempotencyKey);
      const { ranking } = result;
      if (o.json) deps.out(JSON.stringify(ranking, null, 2));
      else for (const r of ranking) deps.out(renderRank(r, result.replayed));
      await guard.after(result.evaluations);
    });

}

async function runComparison(rubric: Rubric | string, subjects: Subject[], deps: CommandDependencies, idempotencyKey?: string) {
  const api = deps.remote();
  // why: even an empty supplied key must reach validation rather than silently disabling idempotency.
  const result = idempotencyKey !== undefined
    ? api ? await api.batches.createIdempotent({ rubric: rubric, subjects }, idempotencyKey) : await deps.engine().evaluateBatchIdempotent(rubric, subjects, { idempotencyKey: idempotencyKey })
    : { ...await (api ? api.batches.create({ rubric: rubric, subjects }) : deps.engine().evaluateBatch(rubric, subjects)), replayed: false };
  return result;
}
function renderRank(r: BatchResult["ranking"][number], replayed: boolean) {
  return `${String(r.rank).padStart(3)}. ${r.subject.padEnd(24)} ${fmt(r.score, 2).padStart(7)}  ${r.grade ?? ""} ${r.passed === undefined ? "" : r.passed ? "PASS" : "FAIL"}  ${r.status !== "completed" ? r.status : ""}${replayed ? " (replayed)" : ""}`;
}

interface CompareOptions { rubric: string; subject: string[]; json?: boolean; mock?: boolean; idempotencyKey?: string; strict?: boolean; lock?: string }

function parseSubject(value: string): Subject {
  const [name, inputs] = value.split(/=(.*)/s);
  if (!name || !inputs) throw new ValidationError("subject must use name=input[,input...]");
  return { name, inputs: inputs.split(",").map(parseInput) };
}
