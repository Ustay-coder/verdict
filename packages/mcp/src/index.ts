import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calibrate, Engine, FileStore, MemoryStore, loadRubricText, parseRubric, type Evaluation } from "@verdict/core";
import { Verdict } from "@verdict/sdk";

/**
 * Verdict MCP server. Two modes:
 *  - local:  runs the engine in-process (set VERDICT_DATA_DIR to persist; needs provider keys e.g. ANTHROPIC_API_KEY)
 *  - remote: proxies to a Verdict API (set VERDICT_API_URL + VERDICT_API_KEY)
 */
export interface McpOptions {
  mode?: "local" | "remote";
  apiUrl?: string;
  apiKey?: string;
  dataDir?: string;
  allowLocalFiles?: boolean;
}

const InputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("json"), data: z.unknown(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("file"), path: z.string().optional(), base64: z.string().optional(), filename: z.string().optional(), mimeType: z.string().optional(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("url"), url: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("youtube"), url: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional(), lang: z.string().optional() }),
]);

function summarize(ev: Evaluation | Record<string, unknown>) {
  const e = ev as Evaluation;
  return {
    id: e.id,
    status: e.status,
    score: e.aggregate?.score,
    grade: e.aggregate?.grade,
    passed: e.aggregate?.passed,
    partial: e.aggregate?.partial,
    criteria: e.criteria?.map((c) => ({ id: c.criterionId, name: c.name, status: c.status, choice: c.choice, score: c.score, normalized: c.normalized, pending: c.pending, confidence: c.ratings?.find((r) => typeof r.confidence === "number")?.confidence, probabilities: c.ratings?.find((r) => r.probabilities)?.probabilities, rationale: c.ratings?.find((r) => r.rationale)?.rationale, quotes: c.ratings?.flatMap((r) => r.quotes ?? []).slice(0, 3) })),
    pendingTasks: e.pendingTasks,
    error: e.error,
    usage: e.usage,
  };
}

export function createMcpServer(opts: McpOptions = {}) {
  const mode = opts.mode ?? (process.env.VERDICT_API_URL ? "remote" : "local");
  const client = mode === "remote" ? new Verdict({ baseUrl: opts.apiUrl ?? process.env.VERDICT_API_URL, apiKey: opts.apiKey ?? process.env.VERDICT_API_KEY }) : undefined;
  const engine = mode === "local" ? new Engine({ store: (opts.dataDir ?? process.env.VERDICT_DATA_DIR) ? new FileStore(opts.dataDir ?? process.env.VERDICT_DATA_DIR!) : new MemoryStore(), ingest: { allowLocalFiles: opts.allowLocalFiles ?? true } }) : undefined;

  const server = new McpServer({ name: "verdict", version: "0.1.0" }, { instructions: "Verdict scores documents, websites, YouTube videos, JSON and text against customizable rubrics. Judges: decision models (Jev / Clef / OpenAI Decisions — typed questions, probabilities, one call per rubric), humans, deterministic benchmarks, optional generative LLM for rationales. Create or inline a rubric, then call evaluate." });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

  server.registerTool("validate_rubric", {
    title: "Validate rubric",
    description: "Validate a rubric (JSON object or YAML string) and return it with defaults filled in. Use before evaluate to catch mistakes.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]) },
  }, async ({ rubric }) => {
    try { return text({ valid: true, rubric: typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric) }); }
    catch (e) { return text({ valid: false, error: (e as Error).message }); }
  });

  server.registerTool("create_rubric", {
    title: "Create rubric",
    description: "Store a rubric and get back its id for reuse. Criteria need id/name; optional weight, scale, anchors (= rubric levels for decision models), judge ({type: decision|human|benchmark|llm|panel}; default decision/typesafe). Aggregation supports weighted_mean, weighted_sum, mean, median, min, max, geometric_mean, formula; gates; grades; passThreshold.",
    inputSchema: { rubric: z.union([z.string(), z.record(z.string(), z.unknown())]) },
  }, async ({ rubric }) => {
    const parsed = typeof rubric === "string" ? loadRubricText(rubric) : parseRubric(rubric);
    return text(client ? await client.rubrics.create(parsed) : await engine!.createRubric(parsed));
  });

  server.registerTool("list_rubrics", { title: "List rubrics", description: "List stored rubrics.", inputSchema: {} }, async () =>
    text(client ? (await client.rubrics.list()).data.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length })) : (await engine!.store.listRubrics()).map((r) => ({ id: r.id, name: r.name, criteria: r.criteria.length }))));

  server.registerTool("calibration_report", {
    title: "Calibration report", description: "Compare decision confidence against human consensus on stored evaluations.",
    inputSchema: { rubricId: z.string(), target: z.number().min(0).max(1).optional(), buckets: z.number().int().min(1).max(1000).optional() },
  }, async ({ rubricId, ...options }) => {
    if (client) return text(await client.rubrics.calibration(rubricId, options));
    await engine!.resolveRubric(rubricId);
    return text(calibrate(await engine!.store.listEvaluations({ rubricId, limit: 1000 }), options));
  });

  server.registerTool("evaluate", {
    title: "Evaluate",
    description: "Score a subject against a rubric. `rubric` is a stored rubric id or an inline rubric. Inputs can be text, json, file (path or base64), url, or youtube. Returns the total score, grade, pass/fail, per-criterion scores with rationales, and any pending human tasks.",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]),
      inputs: z.array(InputSchema).min(1),
      name: z.string().optional().describe("Subject name for reports"),
      idempotencyKey: z.string().min(1).max(255).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({ rubric, inputs, name, metadata, idempotencyKey }) => {
    const r = typeof rubric === "string" ? rubric : parseRubric(rubric);
    const result = idempotencyKey
      ? client ? await client.evaluations.createIdempotent({ rubric: r, inputs: inputs as never, name, metadata }, idempotencyKey)
        : await engine!.evaluateIdempotent({ rubric: r, subject: { name, inputs: inputs as never }, metadata, idempotencyKey })
      : { evaluation: client ? await client.evaluations.create({ rubric: r, inputs: inputs as never, name, metadata }) : await engine!.evaluate({ rubric: r, subject: { name, inputs: inputs as never }, metadata }), replayed: false };
    return text({ ...summarize(result.evaluation as unknown as Evaluation), replayed: result.replayed });
  });

  server.registerTool("compare", {
    title: "Compare / rank",
    description: "Evaluate several subjects against one rubric and return a ranking (leaderboard).",
    inputSchema: {
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]),
      idempotencyKey: z.string().min(1).max(255).optional(),
      subjects: z.array(z.object({ name: z.string(), inputs: z.array(InputSchema).min(1) })).min(2),
    },
  }, async ({ rubric, subjects, idempotencyKey }) => {
    const r = typeof rubric === "string" ? rubric : parseRubric(rubric);
    const result = idempotencyKey
      ? client ? await client.batches.createIdempotent({ rubric: r, subjects: subjects as never }, idempotencyKey) : await engine!.evaluateBatchIdempotent(r, subjects as never, { idempotencyKey })
      : { ...await (client ? client.batches.create({ rubric: r, subjects: subjects as never }) : engine!.evaluateBatch(r, subjects as never)), replayed: false };
    return text({ ranking: result.ranking, replayed: result.replayed });
  });

  server.registerTool("get_evaluation", { title: "Get evaluation", description: "Fetch an evaluation by id (status, scores, rationales, pending human tasks).", inputSchema: { id: z.string() } }, async ({ id }) => {
    if (client) return text(summarize(await client.evaluations.get(id) as unknown as Evaluation));
    const ev = await engine!.store.getEvaluation(id);
    return text(ev ? summarize(ev) : { error: `evaluation ${id} not found` });
  });

  server.registerTool("submit_human_score", {
    title: "Submit human score",
    description: "Submit a human rater's score for a criterion that is waiting on a human. Score is a number on the criterion scale or an ordinal/binary label.",
    inputSchema: { evaluationId: z.string(), criterionId: z.string(), raterId: z.string(), score: z.union([z.number(), z.string()]), rationale: z.string().optional() },
  }, async ({ evaluationId, ...s }) => text(summarize(client ? (await client.evaluations.submitScore(evaluationId, s)) as unknown as Evaluation : await engine!.submitScore(evaluationId, s))));

  server.registerTool("reaggregate", {
    title: "Re-aggregate",
    description: "Recompute the total with a different aggregation (method, formula, weights via gates/grades/passThreshold) without re-running judges. Useful for what-if analysis.",
    inputSchema: { evaluationId: z.string(), aggregation: z.record(z.string(), z.unknown()), persist: z.boolean().default(false) },
  }, async ({ evaluationId, aggregation, persist }) => text(summarize(client ? (await client.evaluations.reaggregate(evaluationId, aggregation as never, persist)) as unknown as Evaluation : await engine!.reaggregate(evaluationId, aggregation as never, undefined, persist))));

  server.registerTool("list_human_tasks", { title: "List human tasks", description: "Criteria waiting on human raters.", inputSchema: { rater: z.string().optional() } }, async ({ rater }) => {
    if (client) return text((await client.tasks.list(rater)).data);
    const list = await engine!.store.listEvaluations({ status: "pending_human", limit: 500 });
    return text(list.flatMap((e) => e.pendingTasks.filter((t) => !rater || (t.raterId ? t.raterId === rater : !t.allowedRaters || t.allowedRaters.includes(rater))).map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t }))));
  });

  return server;
}
