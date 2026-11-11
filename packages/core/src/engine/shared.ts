/**
 * Builds lifecycle records and shared aggregation scaffolding.
 * Checks must survive reaggregation; reservations use the same initial document shape as live runs.
 */
import { newId } from "./ids.js";
import type { AggregateResult, Evaluation } from "../schema/evaluation.js";
import { type Rubric } from "../schema/rubric.js";
import { Subject } from "../schema/subject.js";

import type { EvaluateRequest } from "./types.js";

/** Applies recorded check outcomes to an aggregate in place; does not call providers. */
export function applyChecks(ev: Evaluation) {
  for (const check of ev.checks ?? []) {
    if (!check.passed && check.action === "fail" && !check.error) {
      ev.aggregate.gates.push({ criterion: `check:${check.id}`, passed: false, message: check.message });
      ev.aggregate.passed = false;
    }
    if (!check.passed && check.action === "abort") {
      ev.aggregate.score = undefined;
      ev.aggregate.raw = undefined;
      ev.aggregate.passed = false;
      ev.aggregate.partial = false;
    }
  }
}

/** Returns an unscored partial aggregate using the frozen rubric policy; never throws for validated rubrics. */
export function emptyAggregate(rubric: Rubric): AggregateResult {
  return { method: rubric.aggregation.method, range: rubric.aggregation.normalize === false ? null : rubric.aggregation.normalize, gates: [], partial: true, included: [], excluded: [] };
}

/** Creates a running document using the supplied clock; throws on invalid subject inputs. */
export function initialEvaluation(req: EvaluateRequest, rubric: Rubric, rubricId?: string, clock: () => number = Date.now): Evaluation {
  const now = new Date(clock()).toISOString();
  return {
    id: req.id ?? newId("eval"),
    idempotencyKey: req.idempotencyKey,
    tenantId: req.tenantId,
    rubricId,
    rubric,
    subject: Subject.parse(req.subject),
    evidence: [],
    status: "running",
    criteria: [],
    aggregate: emptyAggregate(rubric),
    pendingTasks: [],
    usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    metadata: req.metadata,
    webhook: req.webhook,
    ...(req.batchId ? { batchId: req.batchId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
