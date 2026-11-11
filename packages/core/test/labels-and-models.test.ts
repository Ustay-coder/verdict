import { describe, expect, it } from "vitest";
import { answerToScore, binaryMargin, calibrate, checkAgainstHumans, criterionLevels, DecisionJudge, Engine, parseGoldSet, parseRubric, validateGoldLabels, type DecisionRaw } from "../src/index.js";
import { stats } from "../src/ingest/index.js";
import type { JudgeContext } from "../src/judges/types.js";

// The mock decision provider answers noul questions with options.noul when given, else 0.75.
const binaryRubric = (threshold?: number) => parseRubric({
  name: "Wants an agent",
  defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "wants_agent", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] }, ...(threshold === undefined ? {} : { threshold }) }],
});

const contextFor = (rubric: ReturnType<typeof parseRubric>, fetchImpl: typeof fetch = globalThis.fetch): JudgeContext => ({
  rubric, criterion: rubric.criteria[0]!, scale: rubric.criteria[0]!.scale ?? rubric.scale,
  evidence: [{ inputIndex: 0, kind: "text", label: "doc", tags: [], text: "hello", stats: stats("hello") }],
  evaluationId: "e", env: (n: string) => (n === "TYPESAFE_API_KEY" ? "k" : undefined), fetch: fetchImpl,
  usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
});

describe("binary threshold", () => {
  it("cuts P(true) at the criterion threshold and measures the margin from that threshold", () => {
    const rubric = binaryRubric(0.3);
    const levels = criterionLevels(rubric, rubric.criteria[0]!, rubric.criteria[0]!.scale!);
    const r = answerToScore({ type: "noul", noul: 0.4 }, levels, rubric.criteria[0]!.scale!, 0.3);
    expect(r.score).toBe(1);
    expect(r.confidence).toBeCloseTo((0.4 - 0.3) / 0.7);
    expect(answerToScore({ type: "noul", noul: 0.4 }, levels, rubric.criteria[0]!.scale!).score).toBe(0);
  });

  it("keeps |2p − 1| as the margin at the default threshold", () => {
    for (const p of [0, 0.2, 0.5, 0.75, 1]) expect(binaryMargin(p, 0.5)).toBeCloseTo(Math.abs(2 * p - 1));
  });

  it("records the threshold on the rating and whether the rubric set it", async () => {
    const judge = new DecisionJudge({ type: "decision", provider: "mock", options: { noul: 0.4 }, onLowConfidence: "accept", escalateTo: [] });
    const [set] = await judge.rate(contextFor(binaryRubric(0.3)));
    expect(set).toMatchObject({ status: "scored", score: 1 });
    expect(set!.raw).toMatchObject({ threshold: 0.3, thresholdSource: "rubric" });
    const [unset] = await judge.rate(contextFor(binaryRubric()));
    expect(unset).toMatchObject({ status: "scored", score: 0 });
    expect(unset!.raw).toMatchObject({ threshold: 0.5, thresholdSource: "default" });
  });

  it("rejects a threshold outside (0, 1) or on a criterion that is not binary", () => {
    expect(() => binaryRubric(1)).toThrow(/threshold/);
    expect(() => binaryRubric(0)).toThrow(/threshold/);
    expect(() => parseRubric({ name: "r", criteria: [{ id: "x", name: "X", threshold: 0.4 }] })).toThrow(/threshold requires a binary scale/);
  });
});

describe("model identity on decision ratings", () => {
  const typesafe = (body: Record<string, unknown>): typeof fetch => async () => new Response(JSON.stringify({ answers: { wants_agent: { type: "noul", noul: 0.9 } }, ...body }));
  const rate = async (body: Record<string, unknown>, model?: string) => {
    const judge = new DecisionJudge({ type: "decision", provider: "typesafe", ...(model ? { model } : {}), onLowConfidence: "accept", escalateTo: [] });
    const [r] = await judge.rate(contextFor(binaryRubric(), typesafe(body)));
    return r!.raw as DecisionRaw;
  };

  it("keeps the requested alias and the model the response named apart", async () => {
    expect(await rate({ model: "jev-1.13-2026-10-01" }, "jev-latest")).toMatchObject({
      model: "jev-1.13-2026-10-01", requestedModel: "jev-latest", resolvedModel: "jev-1.13-2026-10-01", modelVerified: true,
    });
  });

  it("marks the model unverified when the response does not name one, instead of passing the alias off as resolved", async () => {
    const raw = await rate({}, "jev-latest");
    expect(raw).toMatchObject({ model: "jev-latest", requestedModel: "jev-latest", modelVerified: false });
    expect(raw.resolvedModel).toBeUndefined();
  });

  it("records the provider default as the requested model when the judge names none", async () => {
    expect(await rate({})).toMatchObject({ requestedModel: "jev-latest", modelVerified: false });
  });
});

const triage = {
  name: "Owning team",
  defaultJudge: { type: "decision", provider: "mock", options: { choice: "billing" } },
  criteria: [{ id: "team", name: "Team", choices: { support: "How-to", billing: "Invoices", engineering: "Bugs" } }],
};
const ticket = (name: string, team: string, extra: Record<string, unknown> = {}) => ({ name, inputs: [{ type: "text" as const, text: name }], expected: { team }, ...extra });

describe("gold cases", () => {
  it("compares choice labels by option id", async () => {
    const report = await checkAgainstHumans(new Engine(), triage, [ticket("refund please", "billing"), ticket("app crashes", "engineering")]);
    expect(report.criteria.team).toMatchObject({ n: 2, agreed: 1, agreement: 0.5 });
    const crash = report.results.find((r) => r.name === "app crashes")!;
    expect(crash.criteria.team).toMatchObject({ verdict: "billing", human: "engineering", agrees: false });
  });

  it("rejects an unknown option or an unreadable score before any judge runs", async () => {
    let calls = 0;
    const engine = new Engine({ fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    const remote = { ...triage, defaultJudge: { type: "decision", provider: "typesafe" } };
    await expect(checkAgainstHumans(engine, remote, [ticket("t", "sales")])).rejects.toThrow(/gold case "t", criterion team: expected one of support, billing, engineering/);
    expect(() => validateGoldLabels(binaryRubric(), parseGoldSet(JSON.stringify([{ name: "x", inputs: [{ type: "text", text: "x" }], expected: { wants_agent: "maybe" } }])))).toThrow(/gold case "x"/);
    expect(calls).toBe(0);
    // The same engine does reach the provider once the labels are readable.
    await checkAgainstHumans(engine, remote, [ticket("t", "billing")]);
    expect(calls).toBe(1);
  });

  it("reads expected, label sources and splits, and tallies agreement per split", async () => {
    const report = await checkAgainstHumans(new Engine(), triage, [
      ticket("a", "billing", { split: "development", labelSource: "human" }),
      ticket("b", "support", { split: "evaluation", labelSource: "ai_unreviewed" }),
      ticket("c", "billing", { split: "evaluation", labelSource: "ai_unreviewed" }),
      ticket("d", "billing"),
    ]);
    expect(report.labelSources).toEqual({ human: 1, ai_unreviewed: 2, unspecified: 1 });
    expect(report.results.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(report.results[1]).toMatchObject({ split: "evaluation", labelSource: "ai_unreviewed" });
    // No case carries an overall `passed`, so split tallies count cases but decide none.
    expect(report.splits).toEqual({
      development: { items: 1, decided: 0, agreed: 0, agreement: null },
      evaluation: { items: 2, decided: 0, agreed: 0, agreement: null },
      unspecified: { items: 1, decided: 0, agreed: 0, agreement: null },
    });
  });

  it("derives unique case ids from names and refuses duplicate explicit ids", () => {
    const cases = parseGoldSet(JSON.stringify([ticket("same", "billing"), ticket("same", "billing"), ticket("other", "billing", { id: "same#2" })]));
    expect(cases.map((c) => c.id)).toEqual(["same", "same#3", "same#2"]);
    expect(() => parseGoldSet(JSON.stringify([ticket("x", "billing", { id: "k" }), ticket("y", "billing", { id: "k" })]))).toThrow(/duplicate gold case id "k"/);
  });

  it("accepts the older human.criteria form and refuses both forms at once", () => {
    const [old] = parseGoldSet(JSON.stringify([{ name: "o", inputs: [{ type: "text", text: "o" }], human: { passed: true, criteria: { team: "billing" } } }]));
    expect(old!.human).toEqual({ passed: true, criteria: { team: "billing" } });
    expect(() => parseGoldSet(JSON.stringify([{ ...ticket("b", "billing"), human: { criteria: { team: "billing" } } }]))).toThrow(/expected or human.criteria, not both/);
    expect(() => parseGoldSet(JSON.stringify([{ name: "n", inputs: [{ type: "text", text: "n" }] }]))).toThrow(/give expected or human labels/);
  });
});

describe("choice calibration", () => {
  it("pairs decision choices with the human majority by option id", async () => {
    const engine = new Engine();
    const rubric = { ...triage, criteria: [{ ...triage.criteria[0]!, judge: [{ type: "decision", provider: "mock", options: { choice: "billing" } }, { type: "human", required: 2 }] }] };
    const evaluations = [];
    for (const humans of [["billing", "billing"], ["support", "engineering"]]) {
      let ev = await engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: "t" }] } });
      for (const [i, score] of humans.entries()) ev = await engine.submitScore(ev.id, { criterionId: "team", raterId: `r${i}`, score });
      evaluations.push(ev);
    }
    const report = calibrate(evaluations);
    // Second case: tie between support and engineering resolves to support (declaration order) — billing disagrees.
    expect(report.overall).toMatchObject({ n: 2, agreement: 0.5, meanAbsError: null, bias: null, humanAgreement: null });
  });
});
