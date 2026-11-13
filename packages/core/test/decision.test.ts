import { describe, expect, it } from "vitest";
import { DecisionJudge, answerToScore, buildQuestion, criterionLevels } from "../src/judges/decision.js";
import { parseRubric } from "../src/schema/rubric.js";
import type { JudgeContext } from "../src/judges/types.js";
import { stats } from "../src/ingest/index.js";
import { Engine } from "../src/engine.js";
import { readFileSync } from "node:fs";
import jevFixture from "./fixtures/typesafe-systemone-response.json" with { type: "json" };
import clefFixture from "./fixtures/cloudflare-clef-flash-response.json" with { type: "json" };
import openaiFixture from "./fixtures/openai-decisions-response.json" with { type: "json" };
import geminiFixture from "./fixtures/gemini-decisions-response.json" with { type: "json" };
void readFileSync;

const rubric = parseRubric({
  name: "r",
  context: "Reviewing a pitch.",
  scale: { type: "numeric", min: 1, max: 5 },
  criteria: [
    { id: "problem", name: "Problem clarity", anchors: { "1": "No problem stated", "3": "Vague problem", "5": "Specific, quantified problem" } },
    { id: "team", name: "Team", description: "Founder-market fit" },
    { id: "safe", name: "Brand safe", scale: { type: "binary", labels: ["unsafe", "safe"] }, anchors: { safe: "No profanity or stunts", unsafe: "Profanity, politics or stunts" } },
    { id: "tone", name: "Tone", scale: { type: "ordinal", labels: ["cold", "neutral", "warm"] } },
    { id: "exp", name: "Explicit levels", levels: [{ value: 1, description: "none" }, { value: 5, label: "max", description: "all" }] },
  ],
});
const c = (id: string) => rubric.criteria.find((x) => x.id === id)!;
const ctx = (id: string, text = "We have 10k users."): JudgeContext => ({
  rubric, criterion: c(id), scale: c(id).scale ?? rubric.scale,
  evidence: [{ inputIndex: 0, kind: "text", label: "doc", tags: [], text, stats: stats(text) }],
  evaluationId: "e", env: () => undefined, fetch: globalThis.fetch, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
});

describe("rubric levels", () => {
  it("derives levels from numeric anchors, ordinal labels, binary labels, explicit levels, and auto-buckets", () => {
    expect(criterionLevels(rubric, c("problem")).map((l) => l.value)).toEqual([1, 3, 5]);
    expect(criterionLevels(rubric, c("tone")).map((l) => l.label)).toEqual(["cold", "neutral", "warm"]);
    expect(criterionLevels(rubric, c("safe")).map((l) => l.label)).toEqual(["unsafe", "safe"]);
    expect(criterionLevels(rubric, c("exp")).map((l) => l.label)).toEqual(["1", "max"]);
    const auto = criterionLevels(rubric, c("team"));
    expect(auto).toHaveLength(5);
    expect(auto[0]!.value).toBe(1);
    expect(auto[4]!.value).toBe(5);
    expect(auto[4]!.description).toContain("Founder-market fit");
  });
  it("builds score questions for scales and noul questions for binary criteria", () => {
    const q = buildQuestion(ctx("problem"), criterionLevels(rubric, c("problem")));
    expect(q.type).toBe("score");
    expect((q as { criteria: string[] }).criteria).toEqual(["1: No problem stated", "3: Vague problem", "5: Specific, quantified problem"]);
    expect(q.instructions).toContain("Reviewing a pitch.");
    const n = buildQuestion(ctx("safe"), criterionLevels(rubric, c("safe")));
    expect(n.type).toBe("noul");
    expect((n as { criteria: { true: string } }).criteria.true).toBe("No profanity or stunts");
  });
});

describe("answer mapping", () => {
  const levels = criterionLevels(rubric, c("problem"));
  it("uses per-level probabilities as an expected value over level values", () => {
    const r = answerToScore({ type: "score", probabilities: [0.1, 0.2, 0.7], confidence: 0.6 }, levels, rubric.scale);
    expect(r.score).toBeCloseTo(0.1 * 1 + 0.2 * 3 + 0.7 * 5); // 4.2
    expect(r.probabilities).toEqual({ "1": 0.1, "3": 0.2, "5": 0.7 });
    expect(r.confidence).toBe(0.6);
  });
  it("interpolates a fractional score index when probabilities are absent", () => {
    const r = answerToScore({ type: "score", score: 1.5 }, levels, rubric.scale);
    expect(r.score).toBe(4); // halfway between level values 3 and 5
  });
  it("maps noul to binary with derived confidence", () => {
    const r = answerToScore({ type: "noul", noul: 0.9 }, criterionLevels(rubric, c("safe")), c("safe").scale!);
    expect(r.score).toBe(1);
    expect(r.probabilities).toEqual({ unsafe: 0.1, safe: 0.9 });
    expect(r.confidence).toBeCloseTo(0.8);
  });
});

describe("decision judge", () => {
  it("answers every criterion in one call via rateMany", async () => {
    const j = new DecisionJudge({ type: "decision", provider: "mock", options: { level: 2 }, onLowConfidence: "accept", escalateTo: [] });
    const ctxs = [ctx("problem"), ctx("team"), ctx("safe"), ctx("tone")];
    ctxs.forEach((x) => (x.usage = ctxs[0]!.usage));
    const m = await j.rateMany(ctxs);
    expect(m.size).toBe(4);
    expect(ctxs[0]!.usage.decisionCalls).toBe(1);
    const problem = m.get("problem")![0]!;
    expect(problem.status).toBe("scored");
    expect(problem.score).toBeCloseTo(5, 0);
    expect(problem.probabilities).toBeDefined();
    expect(problem.rationale).toContain("distribution");
  });
  it("sends the System One request shape to TypeSafe and parses answers", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth?: string } | undefined;
    const f: typeof fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { problem: { type: "score", score: 1.8, legend: ["1", "3", "5"], probabilities: [0.05, 0.1, 0.85], confidence: 0.81 } }, usage: { input_tokens: 120, output_tokens: 0 } }));
    };
    const j = new DecisionJudge({ type: "decision", provider: "typesafe", model: "jev-1.13.0", onLowConfidence: "accept", escalateTo: [] });
    const x = { ...ctx("problem"), fetch: f, env: (n: string) => (n === "TYPESAFE_API_KEY" ? "ts_key" : undefined) };
    const [r] = await j.rate(x);
    expect(sent!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent!.auth).toBe("Bearer ts_key");
    expect(sent!.body.model).toBe("jev-1.13.0");
    expect((sent!.body.questions as Record<string, { type: string }>).problem.type).toBe("score");
    expect(typeof sent!.body.state).toBe("string");
    expect(r!.score).toBeCloseTo(0.05 * 1 + 0.1 * 3 + 0.85 * 5);
    expect(r!.confidence).toBe(0.81);
    expect(x.usage.inputTokens).toBe(120);
    expect((r!.raw as { model: string }).model).toBe("jev-1.13.0");
  });
  it("parses a real Jev 1.14 response (fixture captured live): index-keyed legend/probabilities, noul, choice, usage", async () => {
    // Fixture = verbatim answer from api.typesafe.ai for a 4-level score, a noul and a choice question.
    const f: typeof fetch = async () => new Response(JSON.stringify(jevFixture));
    const triage = parseRubric({
      name: "triage", scale: { type: "numeric", min: 0, max: 3 },
      criteria: [
        { id: "urgency", name: "Urgency", levels: [{ value: 0, label: "none", description: "nothing broken" }, { value: 1, label: "low", description: "workaround" }, { value: 2, label: "high", description: "degraded" }, { value: 3, label: "critical", description: "outage" }] },
        { id: "needs_engineer", name: "Needs engineer", scale: { type: "binary", labels: ["no", "yes"] } },
      ],
    });
    const mk = (id: string): JudgeContext => ({ rubric: triage, criterion: triage.criteria.find((x) => x.id === id)!, scale: triage.criteria.find((x) => x.id === id)!.scale ?? triage.scale, evidence: [{ inputIndex: 0, kind: "text", label: "t", tags: [], text: "down", stats: stats("down") }], evaluationId: "e", env: (n) => (n === "TYPESAFE_API_KEY" ? "k" : undefined), fetch: f, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } });
    const j = new DecisionJudge({ type: "decision", provider: "typesafe", onLowConfidence: "accept", escalateTo: [] });
    const ctxs = [mk("urgency"), mk("needs_engineer")];
    ctxs[1]!.usage = ctxs[0]!.usage;
    const m = await j.rateMany(ctxs);
    const u = m.get("urgency")![0]!;
    expect(u.status).toBe("scored");
    expect(u.score).toBe(3);
    expect(u.probabilities).toEqual({ none: 0, low: 0, high: 0, critical: 1 });
    expect(u.confidence).toBe(1);
    expect((u.raw as { model: string }).model).toBe("jev-1.14.0");
    const n = m.get("needs_engineer")![0]!;
    expect(n.score).toBe(1);
    expect(n.probabilities).toEqual({ no: 0.29, yes: 0.71 });
    expect(ctxs[0]!.usage.inputTokens).toBe(480);
    expect(ctxs[0]!.usage.outputTokens).toBe(71);
  });

  it("asks OpenAI Decisions in its own shape and reads a real answer (fixture captured live with gpt-6-luna)", async () => {
    // Fixture = verbatim answer from api.openai.com/v1/decisions to these three questions about a longer text, 2026-11-11.
    let sent: { url: string; body: Record<string, unknown>; auth?: string } | undefined;
    const f: typeof fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify(openaiFixture));
    };
    const triage = parseRubric({
      name: "triage", scale: { type: "numeric", min: 0, max: 3 },
      criteria: [
        { id: "urgency", name: "Urgency", levels: [{ value: 0, label: "none", description: "question or feedback, nothing broken" }, { value: 1, label: "low", description: "minor issue with a workaround" }, { value: 2, label: "high", description: "core feature degraded" }, { value: 3, label: "critical", description: "outage, data loss or billing error" }] },
        { id: "needs_engineer", name: "Needs engineer", scale: { type: "binary", labels: ["no", "yes"] } },
        { id: "team", name: "Team", choices: { support: "how-to questions and account help", engineering: "something is broken", billing: "charges and invoices" } },
      ],
    });
    const usage = { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 };
    const mk = (id: string): JudgeContext => ({ rubric: triage, criterion: triage.criteria.find((x) => x.id === id)!, scale: triage.criteria.find((x) => x.id === id)!.scale ?? triage.scale, evidence: [{ inputIndex: 0, kind: "text", label: "t", tags: [], text: "down", stats: stats("down") }], evaluationId: "e", env: (n) => (n === "OPENAI_API_KEY" ? "k" : undefined), fetch: f, usage });
    const m = await new DecisionJudge({ type: "decision", provider: "openai", onLowConfidence: "accept", escalateTo: [] }).rateMany(triage.criteria.map((c) => mk(c.id)));

    expect(sent!.url).toBe("https://api.openai.com/v1/decisions");
    expect(sent!.auth).toBe("Bearer k");
    // The live API refuses any field it does not know, so the body is held to exactly these.
    expect(Object.keys(sent!.body).sort()).toEqual(["input", "model", "questions"]);
    expect(sent!.body.model).toBe("gpt-6-luna");
    expect(sent!.body.input).toContain("down");
    const [score, predicate, choice] = sent!.body.questions as Record<string, unknown>[];
    expect(Object.keys(score!).sort()).toEqual(["instructions", "levels", "name", "type"]);
    expect(score).toMatchObject({ name: "urgency", type: "score", levels: [{ label: "none", description: "question or feedback, nothing broken" }, { label: "low" }, { label: "high" }, { label: "critical", description: "outage, data loss or billing error" }] });
    expect(Object.keys(predicate!).sort()).toEqual(["instructions", "name", "type"]);
    expect(predicate).toMatchObject({ name: "needs_engineer", type: "predicate" });
    expect(predicate!.instructions).toMatch(/Yes means: .+\. No means: .+\.$/);
    expect(choice).toEqual({ name: "team", type: "choice", instructions: expect.any(String), choices: [{ value: "support", description: "how-to questions and account help" }, { value: "engineering", description: "something is broken" }, { value: "billing", description: "charges and invoices" }] });

    const u = m.get("urgency")![0]!;
    expect(u.status).toBe("scored");
    expect(u.score).toBeCloseTo(2.76);
    expect(u.probabilities).toEqual({ none: 0, low: 0.01, high: 0.22, critical: 0.77 });
    expect(u.confidence).toBe(0.76);
    expect((u.raw as { model: string }).model).toBe("gpt-6-luna");
    const n = m.get("needs_engineer")![0]!;
    expect(n.score).toBe(1);
    expect(n.probabilities).toEqual({ no: 0.02, yes: 0.98 });
    const t = m.get("team")![0]!;
    expect(t.choice).toBe("engineering");
    expect(t.probabilities).toEqual({ support: 0, engineering: 1, billing: 0 });
    expect(usage.inputTokens).toBe(506);
    expect(usage.decisionCalls).toBe(1);
  });
  it("asks Gemini Decisions in its own field names and reads a real answer (fixture captured live with gemini-decision-1)", async () => {
    // Fixture = verbatim answer from generativelanguage.googleapis.com/v1beta/decisions to these three questions about a longer text, 2026-11-12.
    let sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    const f: typeof fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify(geminiFixture));
    };
    const triage = parseRubric({
      name: "triage", scale: { type: "numeric", min: 0, max: 3 },
      criteria: [
        { id: "urgency", name: "Urgency", levels: [{ value: 0, label: "none", description: "question or feedback, nothing broken" }, { value: 1, label: "low", description: "minor issue with a workaround" }, { value: 2, label: "high", description: "core feature degraded" }, { value: 3, label: "critical", description: "outage, data loss or billing error" }] },
        { id: "needs_engineer", name: "Needs engineer", scale: { type: "binary", labels: ["no", "yes"] }, anchors: { no: "support can answer it", yes: "someone has to change code" } },
        { id: "team", name: "Team", choices: { support: "how-to questions and account help", engineering: "something is broken", billing: "charges and invoices" } },
      ],
    });
    const usage = { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 };
    const mk = (id: string): JudgeContext => ({ rubric: triage, criterion: triage.criteria.find((x) => x.id === id)!, scale: triage.criteria.find((x) => x.id === id)!.scale ?? triage.scale, evidence: [{ inputIndex: 0, kind: "text", label: "t", tags: [], text: "down", stats: stats("down") }], evaluationId: "e", env: (n) => (n === "GEMINI_API_KEY" ? "k" : undefined), fetch: f, usage });
    const m = await new DecisionJudge({ type: "decision", provider: "gemini", onLowConfidence: "accept", escalateTo: [] }).rateMany(triage.criteria.map((c) => mk(c.id)));

    expect(sent!.url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(sent!.headers["x-goog-api-key"]).toBe("k");
    expect(sent!.headers.authorization).toBeUndefined();
    // The live API refuses `state` ("Unknown parameter 'state'."), so the body is held to exactly these.
    expect(Object.keys(sent!.body).sort()).toEqual(["input", "model", "questions"]);
    expect(sent!.body.model).toBe("gemini-decision-1");
    expect(sent!.body.input).toContain("down");
    const q = sent!.body.questions as Record<string, { type: string; instructions: string; criteria: unknown }>;
    expect(Object.keys(q)).toEqual(["urgency", "needs_engineer", "team"]);
    expect(q.urgency).toMatchObject({ type: "score", criteria: ["none: question or feedback, nothing broken", "low: minor issue with a workaround", "high: core feature degraded", "critical: outage, data loss or billing error"] });
    // The live API refuses a noul's `true` / `false` ("Unknown parameter 'true' at 'questions.q.criteria'.").
    expect(q.needs_engineer).toEqual({ type: "noul", instructions: expect.any(String), criteria: { true_description: "someone has to change code", false_description: "support can answer it" } });
    expect(q.team).toMatchObject({ type: "choice", criteria: { support: "how-to questions and account help", engineering: "something is broken", billing: "charges and invoices" } });

    const u = m.get("urgency")![0]!;
    expect(u.status).toBe("scored");
    expect(u.score).toBeCloseTo(2.894);
    // The answer lists the levels out of order ("2", "0", "1", "3"); they are read by index.
    expect(u.probabilities).toEqual({ none: 0.002, low: 0.0079, high: 0.0842, critical: 0.9059 });
    const n = m.get("needs_engineer")![0]!;
    expect(n.score).toBe(1);
    expect(n.probabilities).toEqual({ no: 0.0452, yes: 0.9548 });
    const t = m.get("team")![0]!;
    expect(t.choice).toBe("engineering");
    expect(t.probabilities!.engineering).toBeCloseTo(0.9637);
    // The response names no model, so the one asked for is recorded and it is not called verified.
    expect(t.raw).toMatchObject({ requestedModel: "gemini-decision-1", modelVerified: false });
    expect((t.raw as { resolvedModel?: string }).resolvedModel).toBeUndefined();
    expect(usage.inputTokens).toBe(378);
    expect(usage.outputTokens).toBe(0);
    expect(usage.decisionCalls).toBe(1);
  });
  it("waits as long as a rate-limited provider asks and tries again, and gives up after a few tries", async () => {
    // Verbatim from Gemini's free tier on 2026-11-12, when 100 pictures were sent in one run.
    const limited = () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded for model gemini-decision-1 (limit: 50000 input tokens per minute on Free Tier). Please retry in 35s or upgrade your tier." } }), { status: 429 });
    const answered = () => new Response(JSON.stringify({ answers: { problem: { score: 1, probabilities: { "0": 0, "1": 1, "2": 0 } } } }));
    const waits: number[] = [];
    const judge = new DecisionJudge({ type: "decision", provider: "gemini", onLowConfidence: "accept", escalateTo: [] });
    let calls = 0;
    const twice: typeof fetch = async () => (++calls <= 2 ? limited() : answered());
    const [r] = await judge.rate({ ...ctx("problem"), fetch: twice, env: () => "k", wait: async (ms) => { waits.push(ms); } });
    expect(r!.status).toBe("scored");
    expect(calls).toBe(3);
    // 35 seconds as asked, and one more so the retry does not land on the edge of the window.
    expect(waits).toEqual([36_000, 36_000]);

    // A `Retry-After` header is believed over the text, and a provider that names no wait gets a default.
    waits.length = 0; calls = 0;
    const header: typeof fetch = async () => (++calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } }) : ++calls === 3 ? new Response("slow down", { status: 429 }) : answered());
    await judge.rate({ ...ctx("problem"), fetch: header, env: () => "k", wait: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([8_000, 21_000]);

    // Still limited after four more tries: the case fails with what the provider said, having asked five times.
    waits.length = 0; calls = 0;
    const always: typeof fetch = async () => { calls++; return limited(); };
    const [failed] = await judge.rate({ ...ctx("problem"), fetch: always, env: () => "k", wait: async (ms) => { waits.push(ms); } });
    expect(failed!.status).toBe("error");
    expect(failed!.error).toContain("HTTP 429");
    expect(failed!.error).toContain("Rate limit exceeded");
    expect(calls).toBe(5);
    expect(waits).toHaveLength(4);
  });

  it("reports what Gemini said when it refuses a request", async () => {
    // Verbatim from the live API when the key is not one it knows, 2026-11-12 (details left out).
    const f: typeof fetch = async () => new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), { status: 400 });
    const x = { ...ctx("problem"), fetch: f, env: () => undefined };
    const [r] = await new DecisionJudge({ type: "decision", provider: "gemini", onLowConfidence: "accept", escalateTo: [] }).rate(x);
    expect(r!.status).toBe("error");
    expect(r!.error).toContain("gemini");
    expect(r!.error).toContain("API key not valid");
  });
  it("reports an OpenAI answer that is not the documented array instead of guessing", async () => {
    const f: typeof fetch = async () => new Response(JSON.stringify({ model: "gpt-6-luna", answers: { urgency: { score: 1 } } }));
    const x = { ...ctx("problem"), fetch: f, env: (n: string) => (n === "OPENAI_API_KEY" ? "k" : undefined) };
    const [r] = await new DecisionJudge({ type: "decision", provider: "openai", onLowConfidence: "accept", escalateTo: [] }).rate(x);
    expect(r!.status).toBe("error");
    expect(r!.error).toContain("openai");
    expect(r!.error).toContain("answers");
  });

  it("parses a real Clef-flash response (fixture captured live): result envelope, fractional score index, choice probabilities", async () => {
    const f: typeof fetch = async () => new Response(JSON.stringify(clefFixture));
    const triage = parseRubric({
      name: "triage", scale: { type: "numeric", min: 0, max: 3 },
      criteria: [
        { id: "urgency", name: "Urgency", levels: [{ value: 0, label: "none", description: "nothing broken" }, { value: 1, label: "low", description: "workaround" }, { value: 2, label: "high", description: "degraded" }, { value: 3, label: "critical", description: "outage" }] },
        { id: "needs_engineer", name: "Needs engineer", scale: { type: "binary", labels: ["no", "yes"] } },
        { id: "team", name: "Team", choices: { support: "General help", engineering: "Bugs and outages", billing: "Invoices" } },
      ],
    });
    const env = (n: string) => ({ CLOUDFLARE_ACCOUNT_ID: "acc1", CLOUDFLARE_API_TOKEN: "t" } as Record<string, string>)[n];
    const mk = (id: string): JudgeContext => ({ rubric: triage, criterion: triage.criteria.find((x) => x.id === id)!, scale: triage.criteria.find((x) => x.id === id)!.scale ?? triage.scale, evidence: [{ inputIndex: 0, kind: "text", label: "t", tags: [], text: "down", stats: stats("down") }], evaluationId: "e", env, fetch: f, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } });
    const j = new DecisionJudge({ type: "decision", provider: "cloudflare", model: "@cf/cloudflare/clef-flash", onLowConfidence: "accept", escalateTo: [] });
    const ctxs = [mk("urgency"), mk("needs_engineer"), mk("team")];
    ctxs.forEach((x) => (x.usage = ctxs[0]!.usage));
    const m = await j.rateMany(ctxs);
    const u = m.get("urgency")![0]!;
    expect(u.status).toBe("scored");
    expect(u.score).toBeCloseTo(0.0062 * 0 + 0.0055 * 1 + 0.0545 * 2 + 0.9338 * 3, 2);
    expect(u.confidence).toBeCloseTo(0.8335);
    expect(m.get("needs_engineer")![0]!.probabilities).toEqual({ no: 0.157, yes: 0.843 });
    const t = m.get("team")![0]!;
    expect(t.choice).toBe("engineering");
    expect(t.probabilities!.engineering).toBeCloseTo(0.9722);
    expect(t.score).toBeUndefined(); // no values → reported, excluded from totals
    expect(ctxs[0]!.usage.inputTokens).toBe(370);
  });

  it("truncates oversized state to the model's budget and records it", async () => {
    const j = new DecisionJudge({ type: "decision", provider: "mock", options: { stateCharLimit: 100, level: 2 }, onLowConfidence: "accept", escalateTo: [] });
    const [r] = await j.rate(ctx("problem", "x".repeat(5000)));
    expect((r!.raw as { stateTruncated: boolean; stateChars: number }).stateTruncated).toBe(true);
    expect((r!.raw as { stateChars: number }).stateChars).toBeLessThan(200);
  });

  it("sends the Cloudflare body with the required model selector and unwraps the result envelope", async () => {
    let body: Record<string, unknown> | undefined;
    const f: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/cloudflare/clef-flash");
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true, result: { answers: { safe: { type: "noul", noul: 0.95 } }, usage: { prompt_tokens: 40 } } }));
    };
    const j = new DecisionJudge({ type: "decision", provider: "cloudflare", model: "@cf/cloudflare/clef-flash", onLowConfidence: "accept", escalateTo: [] });
    const [r] = await j.rate({ ...ctx("safe"), fetch: f, env: (n) => ({ CLOUDFLARE_ACCOUNT_ID: "acc1", CLOUDFLARE_API_TOKEN: "t" } as Record<string, string>)[n] });
    expect(body!.model).toBe("clef-flash");
    expect(typeof body!.state).toBe("string");
    expect((body!.questions as Record<string, { type: string }>).safe.type).toBe("noul");
    expect(r!.score).toBe(1);
    expect(r!.probabilities).toEqual({ unsafe: 0.05, safe: 0.95 });
  });
  it("escalates low-confidence answers to a human or records an error", async () => {
    const human = new DecisionJudge({ type: "decision", provider: "mock", options: { probabilities: [0.34, 0.33, 0.33] }, minConfidence: 0.5, onLowConfidence: "human", escalateTo: ["alice"] });
    const [h] = await human.rate(ctx("problem"));
    expect(h!.status).toBe("pending");
    expect(h!.judgeType).toBe("human");
    expect(h!.raterId).toBe("alice");
    expect((h!.raw as { escalatedFrom: { confidence: number } }).escalatedFrom.confidence).toBeLessThan(0.5);
    const err = new DecisionJudge({ type: "decision", provider: "mock", options: { probabilities: [0.34, 0.33, 0.33] }, minConfidence: 0.5, onLowConfidence: "error", escalateTo: [] });
    expect((await err.rate(ctx("problem")))[0]!.status).toBe("error");
  });
  it("turns provider failures into error ratings for every criterion", async () => {
    const j = new DecisionJudge({ type: "decision", provider: "typesafe", onLowConfidence: "accept", escalateTo: [] });
    const f: typeof fetch = async () => new Response("rate limited", { status: 429 });
    // A 429 is asked again a few times; the wait is skipped here.
    const wait = async () => {};
    const m = await j.rateMany([{ ...ctx("problem"), fetch: f, wait }, { ...ctx("team"), fetch: f, wait }]);
    expect(m.get("problem")![0]!.status).toBe("error");
    expect(m.get("team")![0]!.error).toMatch(/HTTP 429/);
  });
});

describe("engine batching", () => {
  it("makes one decision call per evaluation for criteria sharing the default judge, and escalation completes via submitScore", async () => {
    const engine = new Engine();
    const ev = await engine.evaluate({
      rubric: {
        name: "batch",
        scale: { type: "numeric", min: 1, max: 5 },
        defaultJudge: { type: "decision", provider: "mock", options: { level: 2 } },
        criteria: [
          { id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" },
          { id: "d", name: "D", inputs: ["other"] },                       // different evidence → separate call
          { id: "e", name: "E", judge: { type: "decision", provider: "mock", options: { noul: 0.55 }, minConfidence: 0.3, onLowConfidence: "human" }, scale: { type: "binary" } },
        ],
      },
      subject: { inputs: [{ type: "text", text: "main doc" }, { type: "text", text: "other doc", tags: ["other"] }] },
    });
    expect(ev.usage.decisionCalls).toBe(3); // a+b+c share one call; d (other evidence) and e (other spec) each get their own
    expect(ev.status).toBe("pending_human");
    expect(ev.criteria.find((x) => x.criterionId === "a")!.score).toBe(3);
    expect(ev.criteria.find((x) => x.criterionId === "d")!.score).toBe(3);
    const done = await engine.submitScore(ev.id, { criterionId: "e", raterId: "reviewer", score: "pass" });
    expect(done.status).toBe("completed");
    expect(done.criteria.find((x) => x.criterionId === "e")!.score).toBe(1);
  });
});

it("returns error ratings for invalid state limits without calling a provider", async () => {
  const judge = new DecisionJudge({ type: "decision", provider: "mock", options: { stateCharLimit: NaN }, onLowConfidence: "accept", escalateTo: [] });
  const context = ctx("problem");
  const ratings = await judge.rate(context);
  expect(ratings[0]).toMatchObject({ status: "error", error: expect.stringContaining("stateCharLimit") });
  expect(context.usage.decisionCalls).toBe(0);
});
