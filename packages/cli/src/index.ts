import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { Engine, FileStore, MemoryStore, loadRubricText, parseRubric, youtubeId, type Evaluation, type Input, type Rubric } from "@verdict/core";
import { Verdict } from "@verdict/sdk";

const dataDir = () => process.env.VERDICT_DATA_DIR ?? resolve(process.cwd(), ".verdict");

function localEngine() {
  return new Engine({ store: new FileStore(dataDir()), ingest: { allowLocalFiles: true } });
}
function remote(): Verdict | undefined {
  return process.env.VERDICT_API_URL ? new Verdict({ baseUrl: process.env.VERDICT_API_URL, apiKey: process.env.VERDICT_API_KEY }) : undefined;
}

/** `-i` values: a path, a URL, a YouTube URL, `text:...`, `json:...`; with optional `#tag` suffix after a space? keep simple: `tag=path`. */
export function parseInput(raw: string): Input {
  let tags: string[] | undefined;
  let label: string | undefined;
  const m = /^([a-zA-Z0-9_-]+)=(.+)$/.exec(raw);
  if (m && !/^https?$/.test(m[1]!)) { label = m[1]; tags = [m[1]!]; raw = m[2]!; }
  if (raw.startsWith("text:")) return { type: "text", text: raw.slice(5), label, tags };
  if (raw.startsWith("json:")) return { type: "json", data: JSON.parse(raw.slice(5)), label, tags };
  if (/^https?:\/\//.test(raw)) return youtubeId(raw) ? { type: "youtube", url: raw, label, tags } : { type: "url", url: raw, label, tags };
  if (raw === "-") return { type: "text", text: "", label: label ?? "stdin", tags };
  return { type: "file", path: resolve(raw), filename: basename(raw), label, tags };
}

async function loadRubric(ref: string): Promise<Rubric | string> {
  if (/\.(ya?ml|json)$/i.test(ref)) return loadRubricText(await readFile(ref, "utf8"));
  return ref; // stored id
}

function fmt(n: number | undefined, p = 1) { return n === undefined ? "—" : n.toFixed(p); }

export function renderReport(ev: Evaluation): string {
  const lines: string[] = [];
  const a = ev.aggregate;
  lines.push(`${ev.rubric.name}${ev.subject.name ? ` — ${ev.subject.name}` : ""}`);
  lines.push(`status: ${ev.status}${a.partial ? " (provisional)" : ""}   id: ${ev.id}`);
  lines.push(`score: ${fmt(a.score, 2)}${a.range ? ` / ${a.range[1]}` : ""}${a.grade ? `   grade: ${a.grade}` : ""}${a.passed !== undefined ? `   ${a.passed ? "PASS" : "FAIL"}` : ""}`);
  lines.push("");
  const w = Math.max(...ev.criteria.map((c) => c.name.length), 8);
  for (const c of ev.criteria) {
    const s = typeof c.score === "number" ? `${fmt(c.score, 2)} (${fmt((c.normalized ?? 0) * 100, 0)}%)` : c.status;
    lines.push(`  ${c.name.padEnd(w)}  w=${c.weight}  ${s}${c.pending ? `  [${c.pending} pending]` : ""}${c.gate && !c.gate.passed ? "  GATE FAILED" : ""}`);
    const r = c.ratings.find((x) => x.rationale);
    if (r?.rationale) lines.push(`  ${"".padEnd(w)}  ${r.rationale.replace(/\s+/g, " ").slice(0, 160)}${typeof r.confidence === "number" ? `  [conf ${r.confidence.toFixed(2)}]` : ""}`);
    for (const e of c.ratings.filter((x) => x.status === "error")) lines.push(`  ${"".padEnd(w)}  error(${e.raterId}): ${e.error}`);
  }
  if (ev.pendingTasks.length) { lines.push(""); lines.push(`waiting on humans: ${ev.pendingTasks.map((t) => `${t.criterionId} (${t.raterId ?? (t.allowedRaters ? `one of ${t.allowedRaters.join("|")}` : "anyone")})`).join(", ")}`); lines.push(`  submit with: verdict score ${ev.id} <criterionId> --rater <id> --score <n>`); }
  if (ev.error) lines.push(`error: ${ev.error}`);
  lines.push("");
  lines.push(`decision calls: ${ev.usage.decisionCalls}  llm calls: ${ev.usage.llmCalls}  tokens in/out: ${ev.usage.inputTokens}/${ev.usage.outputTokens}  ${ev.usage.durationMs}ms`);
  return lines.join("\n");
}

const starterRubric = `# Verdict rubric — see docs/RUBRICS.md for every option
name: Startup pitch review
version: "1"
description: Scores a pitch deck / website / demo video for an early-stage program.
context: |
  You are reviewing applications to a pre-seed accelerator. Be rigorous; most applicants should score in the middle.
language: en
scale: { type: numeric, min: 1, max: 5 }

judges:
  # Decision models answer every criterion in ONE call: state + typed questions -> probabilities (no prose).
  jev:   { type: decision, provider: typesafe, model: jev-latest, minConfidence: 0.35, onLowConfidence: human, escalateTo: [partner_a, partner_b] }
  clef:  { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef-flash" }
  # Generative judge: slower, costs more, but returns a rationale and quotes. Use it where you need an explanation.
  claude: { type: llm, provider: anthropic, model: claude-opus-5-5, effort: medium }
  partner:
    type: human
    raters: [partner_a, partner_b]
    required: 1
    instructions: Rate founder-market fit from the deck and any call notes.

defaultJudge: { type: ref, ref: jev }

criteria:
  - id: problem
    name: Problem clarity
    weight: 2
    # Anchors become the ordered rubric levels the decision model scores on (2-10 levels).
    anchors:
      "1": No clear problem stated
      "3": Problem stated but audience/urgency vague
      "5": "Specific, painful, quantified problem for a named audience"
  - id: traction
    name: Traction evidence
    weight: 2
    judge:
      type: panel
      combine: mean
      judges:
        - { type: ref, ref: jev }
        - { type: ref, ref: clef }
        - { type: benchmark, method: keywords, keywords: [revenue, users, customers, retention, MRR, ARR], mode: ratio }
  - id: team
    name: Team
    weight: 1.5
    judge: { type: ref, ref: partner }
  - id: why_now
    name: Why now (needs an explanation for the memo)
    weight: 1
    judge: { type: ref, ref: claude }
  - id: deck_length
    name: Deck is concise
    weight: 0.5
    optional: true
    judge: { type: benchmark, method: length, unit: words, min: 300, max: 2500 }

aggregation:
  method: weighted_mean
  normalize: [0, 100]
  rater: mean
  gates: [{ criterion: problem, min: 2, message: Problem must be at least somewhat clear }]
  grades: [{ label: invite, min: 75 }, { label: maybe, min: 55 }, { label: pass, min: 0 }]
  passThreshold: 55
`;

export function buildCli() {
  const program = new Command().name("verdict").description("Evaluation engine: rubrics × judges (LLM / human / benchmark) × aggregation").version("0.1.0");

  const rubricCmd = program.command("rubric").description("manage rubrics");
  rubricCmd.command("init [file]").description("write a starter rubric").action(async (file = "rubric.yaml") => { await writeFile(file, starterRubric); console.log(`wrote ${file}`); });
  rubricCmd.command("validate <file>").description("validate a rubric file").action(async (file) => {
    try { const r = loadRubricText(await readFile(file, "utf8")); console.log(`OK: ${r.name} — ${r.criteria.length} criteria, aggregation=${r.aggregation.method}`); }
    catch (e) { console.error(`INVALID: ${(e as Error).message}`); process.exitCode = 1; }
  });
  rubricCmd.command("push <file>").description("store a rubric (remote API if VERDICT_API_URL is set, else local .verdict/)").action(async (file) => {
    const r = loadRubricText(await readFile(file, "utf8"));
    const api = remote();
    const stored = api ? await api.rubrics.create(r) : await localEngine().createRubric(r);
    console.log(stored.id);
  });
  rubricCmd.command("list").action(async () => {
    const api = remote();
    const list = api ? (await api.rubrics.list()).data : await localEngine().store.listRubrics();
    for (const r of list) console.log(`${r.id}\t${r.name}\t${r.criteria.length} criteria`);
  });

  program
    .command("evaluate")
    .alias("eval")
    .description("evaluate inputs against a rubric")
    .requiredOption("-r, --rubric <fileOrId>", "rubric YAML/JSON file, or stored rubric id")
    .requiredOption("-i, --input <input...>", "file path, URL, YouTube URL, text:..., json:... (prefix with tag= to tag)")
    .option("-n, --name <name>", "subject name")
    .option("--json", "print the full evaluation as JSON")
    .option("--evidence", "include ingested evidence text in JSON output")
    .option("--webhook <url>", "POST the result when complete")
    .option("--mock", "use mock providers (no API calls) — overrides every decision and llm judge")
    .action(async (o) => {
      let rubric = await loadRubric(o.rubric);
      if (o.mock && typeof rubric !== "string") rubric = mockify(rubric);
      const inputs = (o.input as string[]).map(parseInput);
      for (const i of inputs) if (i.type === "text" && i.label === "stdin") i.text = await readStdin();
      const api = remote();
      const ev = api
        ? ((await api.evaluations.create({ rubric: rubric as never, inputs, name: o.name, webhook: o.webhook, includeEvidence: o.evidence })) as unknown as Evaluation)
        : await localEngine().evaluate({ rubric, subject: { name: o.name, inputs }, webhook: o.webhook });
      if (o.json) console.log(JSON.stringify(o.evidence ? ev : { ...ev, evidence: ev.evidence?.map((e) => ({ ...e, text: undefined })) }, null, 2));
      else console.log(renderReport(ev));
      if (ev.status === "failed") process.exitCode = 1;
    });

  program
    .command("compare")
    .description("rank several subjects against one rubric (each -s is one subject: name=input[,input...])")
    .requiredOption("-r, --rubric <fileOrId>")
    .requiredOption("-s, --subject <subject...>", "name=input[,input...]")
    .option("--json")
    .option("--mock")
    .action(async (o) => {
      let rubric = await loadRubric(o.rubric);
      if (o.mock && typeof rubric !== "string") rubric = mockify(rubric);
      const subjects = (o.subject as string[]).map((s) => { const [name, rest] = s.split(/=(.*)/s); return { name: name!, inputs: rest!.split(",").map(parseInput) }; });
      const api = remote();
      const ranking = api ? (await api.batches.create({ rubric: rubric as never, subjects })).ranking : (await localEngine().evaluateBatch(rubric, subjects)).ranking;
      if (o.json) console.log(JSON.stringify(ranking, null, 2));
      else for (const r of ranking) console.log(`${String(r.rank).padStart(3)}. ${r.subject.padEnd(24)} ${fmt(r.score, 2).padStart(7)}  ${r.grade ?? ""} ${r.passed === undefined ? "" : r.passed ? "PASS" : "FAIL"}  ${r.status !== "completed" ? r.status : ""}`);
    });

  program.command("get <id>").description("show a stored evaluation").option("--json").action(async (id, o) => {
    const api = remote();
    const ev = api ? ((await api.evaluations.get(id)) as unknown as Evaluation) : await localEngine().store.getEvaluation(id);
    if (!ev) { console.error("not found"); process.exitCode = 1; return; }
    console.log(o.json ? JSON.stringify(ev, null, 2) : renderReport(ev));
  });

  program.command("tasks").description("list criteria waiting on human raters").option("--rater <id>").action(async (o) => {
    const api = remote();
    const tasks = api ? (await api.tasks.list(o.rater)).data : (await localEngine().store.listEvaluations({ status: "pending_human" })).flatMap((e) => e.pendingTasks.map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t })));
    for (const t of tasks) console.log(`${t.evaluationId}\t${t.criterionId}\t${t.raterId ?? (t.allowedRaters ? t.allowedRaters.join("|") : "anyone")}\t${t.rubric}${t.subject ? ` / ${t.subject}` : ""}${t.instructions ? `\n    ${t.instructions}` : ""}`);
    if (!tasks.length) console.log("no pending human tasks");
  });

  program
    .command("score <evaluationId> <criterionId>")
    .description("submit a human score")
    .requiredOption("--rater <id>")
    .requiredOption("--score <value>", "number on the criterion scale, or a label")
    .option("--rationale <text>")
    .action(async (evaluationId, criterionId, o) => {
      const score = Number.isFinite(Number(o.score)) ? Number(o.score) : o.score;
      const api = remote();
      const ev = api ? ((await api.evaluations.submitScore(evaluationId, { criterionId, raterId: o.rater, score, rationale: o.rationale })) as unknown as Evaluation) : await localEngine().submitScore(evaluationId, { criterionId, raterId: o.rater, score, rationale: o.rationale });
      console.log(renderReport(ev));
    });

  program
    .command("reaggregate <evaluationId>")
    .description("what-if: recompute the total with another aggregation, e.g. --method min or --formula 'problem_n*0.7+team_n*0.3'")
    .option("--method <method>")
    .option("--formula <expr>")
    .option("--normalize <lo,hi>")
    .option("--pass <threshold>")
    .option("--persist")
    .action(async (evaluationId, o) => {
      const aggregation: Record<string, unknown> = {};
      if (o.method) aggregation.method = o.method;
      if (o.formula) { aggregation.formula = o.formula; aggregation.method ??= "formula"; }
      if (o.normalize) aggregation.normalize = o.normalize.split(",").map(Number);
      if (o.pass) aggregation.passThreshold = Number(o.pass);
      const api = remote();
      const ev = api ? ((await api.evaluations.reaggregate(evaluationId, aggregation as never, !!o.persist)) as unknown as Evaluation) : await localEngine().reaggregate(evaluationId, aggregation as never, undefined, !!o.persist);
      console.log(renderReport(ev));
    });

  program.command("serve").description("run the HTTP API").option("-p, --port <port>", "port", "8787").option("--database <file>", "SQLite file via Drizzle (same schema as D1); enables DB-managed API keys").option("--data-dir <dir>", "persist as JSON files").option("--allow-local-files").action(async (o) => {
    const { startServer } = await import("@verdict/api/server");
    await startServer({ port: Number(o.port), database: o.database, dataDir: o.dataDir, allowLocalFiles: !!o.allowLocalFiles });
  });

  const keysCmd = program.command("keys").description("manage API keys in a SQLite/D1-compatible database (--database)");
  keysCmd.command("create").requiredOption("--database <file>").requiredOption("--tenant <id>").requiredOption("--name <name>").action(async (o) => {
    const { fromSqliteFile } = await import("@verdict/db/sqlite");
    const { auth } = await fromSqliteFile(o.database);
    const k = await auth.createKey(o.tenant, o.name);
    console.log(`${k.key}\n(id ${k.id}; shown once — store it now)`);
  });
  keysCmd.command("list").requiredOption("--database <file>").requiredOption("--tenant <id>").action(async (o) => {
    const { fromSqliteFile } = await import("@verdict/db/sqlite");
    const { auth } = await fromSqliteFile(o.database);
    for (const k of await auth.listKeys(o.tenant)) console.log(`${k.id}\t${k.prefix}…\t${k.name}\t${k.revokedAt ? "revoked" : "active"}\tlast used ${k.lastUsedAt ?? "never"}`);
  });
  keysCmd.command("revoke <id>").requiredOption("--database <file>").action(async (id, o) => {
    const { fromSqliteFile } = await import("@verdict/db/sqlite");
    const { auth } = await fromSqliteFile(o.database);
    console.log((await auth.revokeKey(id)) ? "revoked" : "not found");
  });

  program.command("mcp").description("run the MCP server over stdio (local engine, or remote if VERDICT_API_URL is set)").action(async () => {
    const { createMcpServer } = await import("@verdict/mcp");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    await createMcpServer().connect(new StdioServerTransport());
  });

  program.command("export <id>").description("dump an evaluation as YAML").action(async (id) => {
    const ev = await localEngine().store.getEvaluation(id);
    if (!ev) { console.error("not found"); process.exitCode = 1; return; }
    console.log(YAML.stringify({ ...ev, evidence: ev.evidence.map((e) => ({ ...e, text: `${e.text.slice(0, 200)}…` })) }));
  });

  return program;
}

/** Replace every decision / llm judge with its mock provider (for dry runs / CI). */
export function mockify(rubric: Rubric): Rubric {
  const walk = (j: unknown): unknown => {
    if (!j || typeof j !== "object") return j;
    const o = j as Record<string, unknown>;
    if (o.type === "llm" || o.type === "decision") return { ...o, provider: "mock" };
    if (o.type === "panel") return { ...o, judges: (o.judges as unknown[]).map(walk) };
    return j;
  };
  return parseRubric({
    ...rubric,
    judges: Object.fromEntries(Object.entries(rubric.judges).map(([k, v]) => [k, walk(v)])),
    defaultJudge: walk(rubric.defaultJudge),
    criteria: rubric.criteria.map((c) => ({ ...c, judge: Array.isArray(c.judge) ? c.judge.map(walk) : walk(c.judge) })),
  });
}

async function readStdin() { let s = ""; for await (const chunk of process.stdin) s += chunk; return s; }
