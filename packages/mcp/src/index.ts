import { summarize } from "./summary.js";
import { evaluateSubject, compareSubjects } from "./operations.js";
import { registerAgreement } from "./agreement.js";
import { registerHub } from "./hub.js";
import { ADDS, JUDGES, READS, RECOMPUTES } from "./annotations.js";
import { text, toolResult } from "./result.js";
import { VERSION } from "./package-version.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
/**
 * Exposes rubric, evaluation and human-review operations as MCP tools.
 * Local engines and remote clients share result projections; transport schemas validate tool arguments.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Aggregation, calibrate, coerceScore, criterionScale, scaleRange, NotFoundError, ValidationError, Engine, FileStore, Input, lazyPlaywrightScreenshot, loadRubricText, MemoryStore, parseRubric } from "@verdict-ai/core";
import { Verdict } from "@verdict-ai/sdk";
import { z } from "zod";

/**
 * Verdict MCP server. Two modes:
 *  - local:  runs the engine in-process (set VERDICT_DATA_DIR to persist; needs provider keys e.g. ANTHROPIC_API_KEY)
 *  - remote: proxies to a Verdict API (set VERDICT_API_URL + VERDICT_API_KEY)
 */
export interface McpOptions {
  engine?: Engine;
  client?: Verdict;
  mode?: "local" | "remote";
  apiUrl?: string;
  apiKey?: string;
  dataDir?: string;
  allowLocalFiles?: boolean;
  /** Hub for hub_search / hub_get / fork_rubric (default: VERDICT_HUB_URL). */
  hubUrl?: string;
  /** Network for hub reads (tests). */
  fetch?: typeof fetch;
}

/** Returns a configured MCP server using local or remote dependencies; transport startup remains the caller responsibility. */
export function createMcpServer(opts: McpOptions = {}) {
  const mode = opts.mode ?? (process.env.VERDICT_API_URL ? "remote" : "local");
  const client = opts.client ?? (mode === "remote" ? new Verdict({ baseUrl: opts.apiUrl ?? process.env.VERDICT_API_URL, apiKey: opts.apiKey ?? process.env.VERDICT_API_KEY }) : undefined);
  const engine = opts.engine ?? (mode === "local" ? new Engine({ store: (opts.dataDir ?? process.env.VERDICT_DATA_DIR) ? new FileStore(opts.dataDir ?? process.env.VERDICT_DATA_DIR!) : new MemoryStore(), ingest: { allowLocalFiles: opts.allowLocalFiles ?? true, screenshot: lazyPlaywrightScreenshot() } }) : undefined);

  const server = new McpServer({ name: "verdict", version: VERSION }, { instructions: "Verdict scores documents, websites, YouTube videos, JSON and text against customizable rubrics. Judges: decision models (Jev / Clef / OpenAI Decisions — typed questions, probabilities, one call per rubric), humans, deterministic benchmarks, optional generative LLM for rationales. Create or inline a rubric, then call evaluate. A usual path: validate_rubric, create_rubric, evaluate (or compare for several subjects); when a result is pending_human, list_human_tasks and submit_human_score finish it. hub_search, hub_get and fork_rubric find and copy published rubrics. Model keys are read from this server's environment, never from a tool call." });

  registerRubrics(server, engine, client);
  registerEvaluations(server, engine, client);
  registerHuman(server, engine, client);
  registerAgreement(server, { engine: client ? undefined : engine, read: (path) => readFile(path, "utf8"), resolve, dirname });
  registerHub(server, { hubUrl: opts.hubUrl ?? process.env.VERDICT_HUB_URL, fetch: opts.fetch, engine, client });
  return server;
}


function registerRubrics(server: McpServer, engine: Engine | undefined, client: Verdict | undefined) {
  server.registerTool("validate_rubric", {
    title: "Validate rubric",
    description: "Check a rubric without storing it. Returns `{ valid: true, rubric }` with defaults filled in, or `{ valid: false, error }` saying what is wrong. Use it before `create_rubric` or `evaluate` on a rubric you wrote or edited. No model is called.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The rubric to check: a JSON object, or YAML or JSON text. It needs a name and at least one criterion with an id and a name.") },
    annotations: READS,
  }, async ({ rubric }) => toolResult(async () => {
    try { return text({ valid: true, rubric: typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric) }); }
    catch (e) { return text({ valid: false, error: (e as Error).message }); }
  }));

  server.registerTool("create_rubric", {
    title: "Create rubric",
    description: "Store a rubric and get back its id for reuse. Criteria need id/name; optional weight, scale, anchors (= rubric levels for decision models), judge ({type: decision|human|benchmark|llm|panel}; default decision/typesafe). Aggregation supports weighted_mean, weighted_sum, mean, median, min, max, geometric_mean, formula; gates; grades; passThreshold. Returns the stored rubric; pass its `id` as `rubric` to `evaluate` or `compare`. Every call stores a new rubric, so call it once per rubric.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The rubric to store: a JSON object, or YAML or JSON text.") },
    annotations: ADDS,
  }, async ({ rubric }) => toolResult(async () => {
    const parsed = typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric);
    return text(client ? await client.rubrics.create(parsed) : await engine!.createRubric(parsed));
  }));

  server.registerTool("list_rubrics", { title: "List rubrics", description: "List the rubrics this server keeps: the id, name and number of criteria of each. Use it to find a rubric id for `evaluate`, `compare` or `calibration_report`. Takes no arguments.", inputSchema: {}, annotations: READS }, async () =>
    toolResult(async () => (text(client ? (await client.rubrics.list()).data.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length })) : (await engine!.store.listRubrics()).map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length }))))));

  server.registerTool("calibration_report", {
    title: "Calibration report",
    description: "Say how far a decision model's confidence can be trusted for one rubric, from stored evaluations where a person scored the same criterion. Returns the number of model–human pairs (`n`), agreement, mean error and bias, agreement per confidence bucket, calibration error (`ece`), agreement between the human raters, and `suggestedMinConfidence`: the lowest confidence from which the model met `target`. It reads stored evaluations only; no judge is called. With no human scores yet it returns `n: 0`.",
    inputSchema: {
      rubricId: z.string().describe("Id of a stored rubric, from `create_rubric` or `list_rubrics`."),
      target: z.number().min(0).max(1).optional().describe("Agreement with people that a confidence bucket must reach to count as trusted, from 0 to 1. Default 0.8."),
      buckets: z.number().int().min(1).max(1000).optional().describe("How many equal ranges to split confidence 0–1 into. Default 5."),
    },
    annotations: READS,
  }, async ({ rubricId, ...options }) => toolResult(async () => {
    if (client) return text(await client.rubrics.calibration(rubricId, options));
    await engine!.resolveRubric(rubricId);
    return text(calibrate(await engine!.store.listEvaluations({ rubricId, limit: 1000 }), options));
  }));

}

function registerEvaluations(server: McpServer, engine: Engine | undefined, client: Verdict | undefined) {
  server.registerTool("evaluate", {
    title: "Evaluate",
    description: "Score a subject against a rubric. `rubric` is a stored rubric id or an inline rubric. Inputs can be text, json, file (path or base64), url (set `screenshot: true` to let vision judges such as Clef see the page), image (PNG/JPEG/WebP, path or base64), or youtube. Returns the total score, grade, pass/fail, per-criterion scores with rationales, and any pending human tasks. It calls the rubric's judges (a decision model needs its provider's key in this server's environment) and stores the evaluation. When a criterion is judged by a person, or a decision judge is set to hand low-confidence answers to one (`onLowConfidence: human`), the status is `pending_human` and `pendingTasks` says what `submit_human_score` should send. For several subjects on one rubric, use `compare`.",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('A stored rubric id (from `create_rubric`, `list_rubrics` or `fork_rubric`), or a whole rubric inline as an object.'),
      inputs: z.array(Input).min(1).describe('What to judge, one or more of: {type: "text", text}, {type: "json", data}, {type: "file", path or base64, filename?}, {type: "url", url, screenshot?}, {type: "image", path or base64}, {type: "youtube", url}. Each may carry a `label`.'),
      name: z.string().optional().describe("Subject name for reports"),
      idempotencyKey: z.string().min(1).max(255).optional().describe('A key of your choosing (1–255 characters). Repeating the call with the same key and the same request returns what was stored, with `replayed: true`, instead of judging again.'),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Free-form fields stored with the evaluation, for your own bookkeeping."),
    },
    annotations: JUDGES,
  }, async ({ rubric, inputs, name, metadata, idempotencyKey }) => toolResult(async () => {
    await validateRubricReference(rubric, engine, client);
    const result = await evaluateSubject({ engine, client }, { rubric, inputs, name, metadata, idempotencyKey });
    return text({ ...summarize(result.evaluation), replayed: result.replayed });
  }));

  server.registerTool("compare", {
    title: "Compare / rank",
    description: "Evaluate two or more subjects against the same rubric and rank them by total score. Returns `ranking`, best first: rank, evaluation id, subject, score, grade, pass/fail and status for each. Every subject is judged and stored as `evaluate` would; read one in full with `get_evaluation`. For a single subject, use `evaluate`.",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('A stored rubric id (from `create_rubric`, `list_rubrics` or `fork_rubric`), or a whole rubric inline as an object.'),
      idempotencyKey: z.string().min(1).max(255).optional().describe('A key of your choosing (1–255 characters). Repeating the call with the same key and the same request returns what was stored, with `replayed: true`, instead of judging again.'),
      subjects: z.array(z.object({ name: z.string(), inputs: z.array(Input).min(1) })).min(2).describe("Two or more subjects to rank, each `{ name, inputs }`, with `inputs` as in `evaluate`."),
    },
    annotations: JUDGES,
  }, async ({ rubric, subjects, idempotencyKey }) => toolResult(async () => {
    await validateRubricReference(rubric, engine, client);
    const result = await compareSubjects({ engine, client }, { rubric, subjects, idempotencyKey });
    return text({ ranking: result.ranking, replayed: result.replayed });
  }));

}

function registerHuman(server: McpServer, engine: Engine | undefined, client: Verdict | undefined) {
  server.registerTool("get_evaluation", { title: "Get evaluation", description: "Read one stored evaluation: its status, total score, grade and pass/fail, each criterion's score, confidence, probabilities and rationale, and any human tasks still pending. Use it to re-read a result or to see one entry of a `compare` ranking in full. It judges nothing.", inputSchema: { id: z.string().describe("Evaluation id, as returned by `evaluate` (`id`) or `compare` (`evaluationId`).") }, annotations: READS }, async ({ id }) => toolResult(async () => {
    if (client) return text(summarize(await client.evaluations.get(id)));
    const ev = await engine!.store.getEvaluation(id);
    return text(ev ? summarize(ev) : { error: `evaluation ${id} not found` });
  }));

  server.registerTool("submit_human_score", {
    title: "Submit human score",
    description: "Submit a human rater's score for a criterion that is waiting on a human. Score is a number on the criterion scale or an ordinal/binary label. Find what is waiting with `list_human_tasks`. Returns the evaluation's summary; once the last pending criterion is scored, the total, grade and pass/fail are filled in.",
    inputSchema: {
      evaluationId: z.string().describe("The evaluation the task belongs to: `evaluationId` from `list_human_tasks`, or `id` from `evaluate`."),
      criterionId: z.string().describe("Id of the criterion being scored, as the pending task names it."),
      raterId: z.string().describe("Who is scoring. When the task names its raters, this must be one of them."),
      score: z.union([z.number(), z.string()]).describe("A number on the criterion's scale, a label of an ordinal or binary scale, or, for a choice criterion, one of its option ids."),
      rationale: z.string().optional().describe("Why this score, in the rater's words. Stored with the score."),
    },
    annotations: ADDS,
  }, async ({ evaluationId, ...s }) => toolResult(async () => {
    // Remote submissions use the API validation against its frozen rubric.
    if (client) return text(summarize(await client.evaluations.submitScore(evaluationId, s)));
    const evaluation = await engine!.store.getEvaluation(evaluationId);
    if (!evaluation) throw new NotFoundError(`evaluation ${evaluationId} not found`);
    const criterion = evaluation.rubric.criteria.find(c => c.id === s.criterionId);
    if (!criterion) throw new ValidationError(`unknown criterion ${s.criterionId}`);
    // Choices have optional score mappings; only scale-based submissions need range validation.
    if (criterion.choices && !Object.hasOwn(criterion.choices, String(s.score))) throw new ValidationError(`unknown choice ${s.score}`);
    if (!criterion.choices) {
      const scale = criterionScale(evaluation.rubric, criterion);
      const [min, max] = scaleRange(scale);
      const numeric = typeof s.score === "number" ? s.score : Number(s.score);
      if (Number.isFinite(numeric) && (numeric < min || numeric > max)) throw new ValidationError(`score must be between ${min} and ${max}`);
      coerceScore(s.score, scale);
    }
    return text(summarize(await engine!.submitScore(evaluationId, s)));
  }));

  server.registerTool("reaggregate", {
    title: "Re-aggregate",
    description: "Recompute an evaluation's total from the scores it already has, under other aggregation rules: a what-if that calls no judge. Returns the summary with the new total, grade and pass/fail. Nothing is stored unless `persist` is true.",
    inputSchema: {
      evaluationId: z.string().describe("Id of the stored evaluation to recompute."),
      aggregation: z.record(z.string(), z.unknown()).describe("The settings to apply, as in a rubric's `aggregation`: any of `method` (weighted_mean, weighted_sum, mean, median, min, max, geometric_mean, formula), `formula`, `gates`, `grades`, `passThreshold`. Settings left out stay as the rubric has them."),
      persist: z.boolean().default(false).describe("true stores the new total on the evaluation; false, the default, only returns it."),
    },
    annotations: RECOMPUTES,
  }, async ({ evaluationId, aggregation, persist }) => toolResult(async () => (text(summarize(client ? (await client.evaluations.reaggregate(evaluationId, Aggregation.partial().parse(aggregation), persist)) : await engine!.reaggregate(evaluationId, Aggregation.partial().parse(aggregation), undefined, persist))))));

  server.registerTool("list_human_tasks", { title: "List human tasks", description: "List the criteria that are waiting for a person to score them, across stored evaluations: the evaluation id, rubric, subject, criterion and who may rate each. It is what `submit_human_score` needs. Returns an empty list when nothing is waiting.", inputSchema: { rater: z.string().optional().describe("Only tasks this rater may take: assigned to them, or open to them. Leave it out for every pending task.") }, annotations: READS }, async ({ rater }) => toolResult(async () => {
    if (client) return text((await client.tasks.list(rater)).data);
    // why: filter only tenant-visible pending work; named assignments take precedence over allowed-rater pools.
    const list = await engine!.store.listEvaluations({ status: "pending_human", limit: TASK_INBOX_LIMIT });
    return text(list.flatMap((e) => e.pendingTasks.filter((t) => !rater || (t.raterId ? t.raterId === rater : !t.allowedRaters || t.allowedRaters.includes(rater))).map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t }))));
  }));

}


// why: match the REST inbox cap so local MCP calls do not scan unbounded evaluation history.
const TASK_INBOX_LIMIT = 500;


// Stored references need a lookup; inline rubrics are validated by the operation parser.
async function validateRubricReference(rubric: string | Record<string, unknown>, engine?: Engine, client?: Verdict) {
  if (typeof rubric !== "string") return;
  // Remote APIs resolve ids themselves; avoid adding a lookup to every remote evaluation.
  if (client) return;
  await engine!.resolveRubric(rubric);
}
