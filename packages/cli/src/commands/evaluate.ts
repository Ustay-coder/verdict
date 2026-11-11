/**
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { type Rubric } from "@verdict-ai/core";
import { Command } from "commander";

import { parseInput, readStdin } from "../inputs.js";
import { addServerRefOptions, serverRubric, type ServerRefOptions } from "../control/server-ref.js";
import type { HubDependencies } from "../hub/deps.js";
import { loadCommandRubric, localEngine, remote } from "../remote.js";
import { renderReport } from "../report.js";
import { guardRubric } from "../versions/guard.js";

/** Registers evaluate operations; handler failures propagate to the transport error boundary. */
export interface EvaluateDependencies {
  loadRubric: typeof loadCommandRubric;
  parseInput: typeof parseInput;
  readStdin: typeof readStdin;
  remote: typeof remote;
  localEngine: typeof localEngine;
  stdout: (text: string) => void;
  setExitCode: (code: number) => void;
  /** Checks a locked rubric file before and after running (verdict.lock); defaults to the real lock file. */
  guard?: typeof guardRubric;
  /** How a rubric named on a server is fetched (tests); defaults to the real network and sign-in. */
  server?: HubDependencies;
}

const defaultDependencies: EvaluateDependencies = {
  loadRubric: loadCommandRubric, parseInput, readStdin, remote, localEngine,
  stdout: text => console.log(text), setExitCode: code => { process.exitCode = code; },
};

export function registerEvaluate(program: Command, dependencies: EvaluateDependencies = defaultDependencies) {
  const command = program
    .command("evaluate")
    .alias("eval")
    .description("evaluate inputs against a rubric")
    .requiredOption("-r, --rubric <ref>", "rubric YAML/JSON file, stored rubric id, or a name on your team's server: <name> with --env, <name>@latest, <name>@rv_…")
    .requiredOption("-i, --input <input...>", "file or image path, URL, YouTube URL, text:..., json:... (prefix with tag= to tag)")
    .option("-n, --name <name>", "subject name")
    .option("--json", "print the full evaluation as JSON")
    .option("--evidence", "include ingested evidence text in JSON output")
    .option("--webhook <url>", "POST the result when complete")
    .option("--idempotency-key <key>")
    .option("--mock", "use mock providers (no API calls) — overrides every decision and llm judge")
    .option("--screenshot", "also screenshot every URL input for vision-capable judges (local engine: needs Playwright)")
    .option("--strict", "fail when the rubric file no longer matches verdict.lock, or sends other questions or reaches another model than its locked run")
    .option("--lock <path>", "lock file", "verdict.lock");
  addServerRefOptions(command)
    .action(async (o: EvaluateOptions) => {
      const guard = await (dependencies.guard ?? guardRubric)(o.rubric, o);
      const rubric = (await serverRubric(o.rubric, o, dependencies.server)) ?? (await dependencies.loadRubric(o.rubric, o.mock));
      const result = await runEvaluation(rubric, o, dependencies);
      const ev = result.evaluation;
      // why: evidence can contain large or sensitive source text; omit it unless explicitly requested.
      if (o.json) dependencies.stdout(JSON.stringify(o.evidence ? ev : { ...ev, evidence: ev.evidence?.map((e) => ({ ...e, text: undefined })) }, null, 2));
      else dependencies.stdout(renderReport(ev).replace(/(Status:[^\n]*)/i, `$1${result.replayed ? " (replayed)" : ""}`));
      // Failed evaluations remain printable while signalling failure to shell callers.
      if (ev.status === "failed") dependencies.setExitCode(1);
      await guard.after([ev]);
    });

}

interface EvaluateOptions extends ServerRefOptions {
  rubric: string; mock?: boolean; json?: boolean; strict?: boolean; lock?: string;
  input: string[]; name?: string; webhook?: string; evidence?: boolean; idempotencyKey?: string; screenshot?: boolean;
}
async function runEvaluation(rubric: Rubric | string, o: EvaluateOptions, dependencies: EvaluateDependencies) {
  const inputs = o.input.map(dependencies.parseInput).map((i) => (o.screenshot && i.type === "url" ? { ...i, screenshot: true } : i));
  // why: stdin is read at execution time, after parsing, so importing or registering commands never consumes it.
  // Only the stdin marker consumes the stream; literal text inputs stay untouched.
  for (const i of inputs) if (i.type === "text" && i.label === "stdin") i.text = await dependencies.readStdin();
  const api = dependencies.remote();
  const params = { rubric: rubric, inputs, name: o.name, webhook: o.webhook, includeEvidence: o.evidence };
  const req = { rubric, subject: { name: o.name, inputs }, webhook: o.webhook };
  // Idempotency is opt-in so ordinary evaluations continue creating independent documents.
  const result = o.idempotencyKey !== undefined
    ? api ? await api.evaluations.createIdempotent(params, o.idempotencyKey) : await dependencies.localEngine().evaluateIdempotent({ ...req, idempotencyKey: o.idempotencyKey })
    : { evaluation: api ? await api.evaluations.create(params) : await dependencies.localEngine().evaluate(req), replayed: false };
  return result;
}
