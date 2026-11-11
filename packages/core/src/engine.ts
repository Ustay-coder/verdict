/**
 * Exposes the composed evaluation engine and stable lifecycle utilities.
 * Implementation layers share one dependency boundary; reaggregation never invokes a judge.
 */
export type { EngineOptions, EngineEvent, EvaluateRequest, ScoreSubmission } from "./engine/types.js";
import { EngineHuman } from "./engine/human.js";

/** Evaluates frozen rubrics through injected dependencies; invalid requests and missing records reject with typed errors. */
export class Engine extends EngineHuman { }
export { newId } from "./engine/ids.js";
export { NotFoundError, ValidationError, ConflictError } from "./engine/errors.js";
export { rankEvaluations } from "./engine/ranking.js";
export { mapLimit } from "./engine/concurrency.js";
