import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { Aggregation } from "@verdict-ai/core";
import { Command } from "commander";

import { renderReport } from "../report.js";

/** Registers reaggregate operations; handler failures propagate to the transport error boundary. */
export function registerReaggregate(program: Command, deps: CommandDependencies = commandDefaults) {
  program
    .command("reaggregate <evaluationId>")
    .description("what-if: recompute the total with another aggregation, e.g. --method min or --formula 'problem_n*0.7+team_n*0.3'")
    .option("--method <method>")
    .option("--formula <expr>")
    .option("--normalize <lo,hi>")
    .option("--pass <threshold>")
    .option("--persist")
    .action(async (evaluationId: string, o: ReaggregateOptions) => {
      const aggregation: Record<string, unknown> = {};
      if (o.method) aggregation.method = o.method;
      // why: a formula implies formula aggregation unless the caller explicitly chose a method.
      if (o.formula) { aggregation.formula = o.formula; aggregation.method ??= "formula"; }
      if (o.normalize) aggregation.normalize = o.normalize.split(",").map(Number);
      if (o.pass) aggregation.passThreshold = Number(o.pass);
      const parsed = Aggregation.partial().parse(aggregation);
      const api = deps.remote();
      const ev = api ? ((await api.evaluations.reaggregate(evaluationId, parsed, !!o.persist))) : await deps.engine().reaggregate(evaluationId, parsed, undefined, !!o.persist);
      deps.out(renderReport(ev));
    });

}

interface ReaggregateOptions { method?: string; formula?: string; normalize?: string; pass?: string; persist?: boolean; }
