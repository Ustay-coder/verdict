import { parseRubric, ValidationError, type Engine, type Input, type Subject } from "@verdict-ai/core";
import type { Verdict } from "@verdict-ai/sdk";

type Dependencies = { engine?: Engine; client?: Verdict };
type RubricReference = string | Record<string, unknown>;

function localEngine(dependencies: Dependencies): Engine {
  if (!dependencies.engine) throw new ValidationError("local MCP operation requires an engine");
  return dependencies.engine;
}

/** Transport-independent operation; the idempotency key selects reservation before any judge work. */
export async function evaluateSubject(dependencies: Dependencies, params: {
  rubric: RubricReference; inputs: Input[]; name?: string; metadata?: Record<string, unknown>; idempotencyKey?: string;
}) {
  const { client } = dependencies;
  const { inputs, name, metadata, idempotencyKey } = params;
  const rubric = typeof params.rubric === "string" ? params.rubric : parseRubric(params.rubric);
  if (client) {
    const request = { rubric, inputs, name, metadata };
    if (idempotencyKey) return client.evaluations.createIdempotent(request, idempotencyKey);
    return { evaluation: await client.evaluations.create(request), replayed: false };
  }
  const engine = localEngine(dependencies);
  const request = { rubric, subject: { name, inputs }, metadata };
  if (idempotencyKey) return engine.evaluateIdempotent({ ...request, idempotencyKey });
  return { evaluation: await engine.evaluate(request), replayed: false };
}

/** Shares local and remote ranking semantics without depending on the MCP server. */
export async function compareSubjects(dependencies: Dependencies, params: {
  rubric: RubricReference; subjects: Subject[]; idempotencyKey?: string;
}) {
  const { client } = dependencies;
  const { subjects, idempotencyKey } = params;
  const rubric = typeof params.rubric === "string" ? params.rubric : parseRubric(params.rubric);
  if (client) {
    if (idempotencyKey) return client.batches.createIdempotent({ rubric, subjects }, idempotencyKey);
    return { ...await client.batches.create({ rubric, subjects }), replayed: false };
  }
  const engine = localEngine(dependencies);
  if (idempotencyKey) return engine.evaluateBatchIdempotent(rubric, subjects, { idempotencyKey });
  return { ...await engine.evaluateBatch(rubric, subjects), replayed: false };
}
