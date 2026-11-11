/**
 * `verdict run --models a,b,c`: one rubric, the same cases, a run per decision model, read side by side. The rubric
 * is not edited: each model gets a version that differs only in which model answers, so the runs are kept and can be
 * compared in detail with `verdict diff` like any others.
 */
import { compareModels, freezeRubric, runCases, ValidationError, type ModelSide } from "@verdict-ai/core";

import { resolveRef, type ServerRefOptions } from "../control/server-ref.js";
import { asksDecisionModel, parseModels, withModel } from "../models.js";
import { renderModels } from "../versions/render-models.js";
import { remember, resolveDataset, type Workspace } from "../versions/workspace.js";

export interface ModelRunOptions extends ServerRefOptions { rubric: string; data: string; models: string; json?: boolean; report?: boolean }

export async function runModels(ws: Workspace, o: ModelRunOptions): Promise<void> {
  const choices = parseModels(o.models);
  if (ws.mock) throw new ValidationError("--mock and --models both say who answers; to try the table without a key, use --models mock");
  // Each model's run is of its own version, so there is no one run to report under the rubric's name.
  if (o.report) throw new ValidationError("--models compares models and reports nothing; report the run you keep with `verdict report run_…`");
  const { version: base } = await resolveRef(ws, o.rubric, o);
  if (!asksDecisionModel(base.rubric)) throw new ValidationError(`${o.rubric} asks no decision model (its criteria are judged by rules, people or prompted models), so another model would change nothing`);
  const dataset = await resolveDataset(ws, o.data);
  const sides: ModelSide[] = [];
  // One after another: each model's time is its own, and no provider is hit harder than a normal run would.
  for (const choice of choices) {
    const version = await remember(ws, await freezeRubric(withModel(base.rubric, choice)));
    const result = await runCases(ws.engine, version, dataset);
    await ws.store.putRun(result.run);
    sides.push({ label: choice.label, version, ...result });
  }
  const comparison = compareModels(sides, dataset);
  if (o.json) { ws.deps.out(JSON.stringify(comparison, null, 2)); return; }
  for (const line of renderModels(comparison, base.rubric.criteria.length)) ws.deps.out(line);
  const kept = sides.filter((s) => s.run.status !== "failed");
  ws.deps.warn(`runs: ${sides.map((s) => `${s.label} ${s.run.id}`).join(", ")}${kept.length > 1 ? `; two of them case by case: verdict diff --base ${kept[0]!.run.id} --head ${kept[1]!.run.id}` : ""}`);
  // A table with no row that answered is a failure to the shell too.
  if (!kept.length) ws.deps.exitCode(1);
}
