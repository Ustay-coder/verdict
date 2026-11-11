import { summarize } from "./summary.js";
import { evaluateSubject, compareSubjects } from "./operations.js";
import { registerAgreement } from "./agreement.js";
import { registerHub } from "./hub.js";
import { text, toolResult } from "./result.js";
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

  const server = new McpServer({ name: "verdict", version: "0.1.0" }, { instructions: "Verdict scores documents, websites, YouTube videos, JSON and text against customizable rubrics. Judges: decision models (Jev / Clef / OpenAI Decisions — typed questions, probabilities, one call per rubric), humans, deterministic benchmarks, optional generative LLM for rationales. Create or inline a rubric, then call evaluate." });

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
    description: "Validate a rubric (JSON object or YAML string) and return it with defaults filled in. Use before evaluate to catch mistakes.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]) },
  }, async ({ rubric }) => toolResult(async () => {
    try { return text({ valid: true, rubric: typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric) }); }
    catch (e) { return text({ valid: false, error: (e as Error).message }); }
  }));

  server.registerTool("create_rubric", {
    title: "Create rubric",
    description: "Store a rubric and get back its id for reuse. Criteria need id/name; optional weight, scale, anchors (= rubric levels for decision models), judge ({type: decision|human|benchmark|llm|panel}; default decision/typesafe). Aggregation supports weighted_mean, weighted_sum, mean, median, min, max, geometric_mean, formula; gates; grades; passThreshold.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]) },
  }, async ({ rubric }) => toolResult(async () => {
    const parsed = typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric);
    return text(client ? await client.rubrics.create(parsed) : await engine!.createRubric(parsed));
  }));

  server.registerTool("list_rubrics", { title: "List rubrics", description: "List stored rubrics.", inputSchema: {} }, async () =>
    toolResult(async () => (text(client ? (await client.rubrics.list()).data.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length })) : (await engine!.store.listRubrics()).map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length }))))));

  server.registerTool("calibration_report", {
    title: "Calibration report", description: "Compare decision confidence against human consensus on stored evaluations.",
    inputSchema: { rubricId: z.string(), target: z.number().min(0).max(1).optional(), buckets: z.number().int().min(1).max(1000).optional() },
  }, async ({ rubricId, ...options }) => toolResult(async () => {
    if (client) return text(await client.rubrics.calibration(rubricId, options));
    await engine!.resolveRubric(rubricId);
    return text(calibrate(await engine!.store.listEvaluations({ rubricId, limit: 1000 }), options));
  }));

}

function registerEvaluations(server: McpServer, engine: Engine | undefined, client: Verdict | undefined) {
  server.registerTool("evaluate", {
    title: "Evaluate",
    description: "Score a subject against a rubric. `rubric` is a stored rubric id or an inline rubric. Inputs can be text, json, file (path or base64), url (set `screenshot: true` to let vision judges such as Clef see the page), image (PNG/JPEG/WebP, path or base64), or youtube. Returns the total score, grade, pass/fail, per-criterion scores with rationales, and any pending human tasks.",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]),
      inputs: z.array(Input).min(1),
      name: z.string().optional().describe("Subject name for reports"),
      idempotencyKey: z.string().min(1).max(255).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({ rubric, inputs, name, metadata, idempotencyKey }) => toolResult(async () => {
    await validateRubricReference(rubric, engine, client);
    const result = await evaluateSubject({ engine, client }, { rubric, inputs, name, metadata, idempotencyKey });
    return text({ ...summarize(result.evaluation), replayed: result.replayed });
  }));

  server.registerTool("compare", {
    title: "Compare / rank",
    description: "Evaluate several subjects against one rubric and return a ranking (leaderboard).",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]),
      idempotencyKey: z.string().min(1).max(255).optional(),
      subjects: z.array(z.object({ name: z.string(), inputs: z.array(Input).min(1) })).min(2),
    },
  }, async ({ rubric, subjects, idempotencyKey }) => toolResult(async () => {
    await validateRubricReference(rubric, engine, client);
    const result = await compareSubjects({ engine, client }, { rubric, subjects, idempotencyKey });
    return text({ ranking: result.ranking, replayed: result.replayed });
  }));

}

function registerHuman(server: McpServer, engine: Engine | undefined, client: Verdict | undefined) {
  server.registerTool("get_evaluation", { title: "Get evaluation", description: "Fetch an evaluation by id (status, scores, rationales, pending human tasks).", inputSchema: { id: z.string() } }, async ({ id }) => toolResult(async () => {
    if (client) return text(summarize(await client.evaluations.get(id)));
    const ev = await engine!.store.getEvaluation(id);
    return text(ev ? summarize(ev) : { error: `evaluation ${id} not found` });
  }));

  server.registerTool("submit_human_score", {
    title: "Submit human score",
    description: "Submit a human rater's score for a criterion that is waiting on a human. Score is a number on the criterion scale or an ordinal/binary label.",
    inputSchema: { evaluationId: z.string(), criterionId: z.string(), raterId: z.string(), score: z.union([z.number(), z.string()]), rationale: z.string().optional() },
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
    description: "Recompute the total with a different aggregation (method, formula, weights via gates/grades/passThreshold) without re-running judges. Useful for what-if analysis.",
    inputSchema: { evaluationId: z.string(), aggregation: z.record(z.string(), z.unknown()), persist: z.boolean().default(false) },
  }, async ({ evaluationId, aggregation, persist }) => toolResult(async () => (text(summarize(client ? (await client.evaluations.reaggregate(evaluationId, Aggregation.partial().parse(aggregation), persist)) : await engine!.reaggregate(evaluationId, Aggregation.partial().parse(aggregation), undefined, persist))))));

  server.registerTool("list_human_tasks", { title: "List human tasks", description: "Criteria waiting on human raters.", inputSchema: { rater: z.string().optional() } }, async ({ rater }) => toolResult(async () => {
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
