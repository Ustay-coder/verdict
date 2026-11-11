import { describe, expect, it } from "vitest";
import { checkAgainstHumans, checkInput, Engine, InputSchema, parseRubric } from "../src/index.js";
import { transientErrors } from "../src/engine/errors.js";

const agentIntent = {
  type: "object",
  required: ["utterance"],
  properties: { utterance: { type: "string", minLength: 1 }, recent_context: { type: "string" } },
  additionalProperties: false,
} as const;

const rubric = (judge: Record<string, unknown> = { type: "decision", provider: "mock" }) => ({
  name: "Wants an agent",
  inputSchema: agentIntent,
  defaultJudge: judge,
  criteria: [{ id: "wants_agent", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] } }],
});

describe("checkInput", () => {
  it("accepts a matching value and reports each mismatch with its path", () => {
    expect(checkInput(agentIntent, { utterance: "상담원 연결해 주세요." })).toEqual([]);
    expect(checkInput(agentIntent, { recent_context: 3, extra: true })).toEqual([
      { path: "$.utterance", message: "is required" },
      { path: "$.recent_context", message: "expected string, got integer" },
      { path: "$.extra", message: "is not allowed" },
    ]);
    expect(checkInput(agentIntent, { utterance: "" })).toEqual([{ path: "$.utterance", message: "must have at least 1 characters" }]);
    expect(checkInput(agentIntent, ["not", "an", "object"])).toEqual([{ path: "$", message: "expected object, got array" }]);
  });

  it("checks arrays, numbers, enums, const and patterns, and counts characters by code point", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", minItems: 1, items: { enum: ["a", "b"] } },
        score: { type: "number", minimum: 0, maximum: 1 },
        kind: { const: "ticket" },
        code: { type: "string", pattern: "^[A-Z]{3}-\\d+$" },
        nick: { type: "string", maxLength: 2 },
        "my key": { type: ["string", "null"] },
      },
    } as const;
    expect(checkInput(schema, { tags: ["a"], score: 1, kind: "ticket", code: "ABC-12", nick: "한글", "my key": null })).toEqual([]);
    expect(checkInput(schema, { tags: ["c"], score: 2, kind: "x", code: "abc", "my key": 1 }).map((i) => i.path)).toEqual([
      "$.tags[0]", "$.score", "$.kind", "$.code", '$["my key"]',
    ]);
    expect(checkInput({ type: "number" }, 3)).toEqual([]);
    expect(checkInput({ type: "integer" }, 3.5)).toEqual([{ path: "$", message: "expected integer, got number" }]);
  });

  it("rejects keywords it would not enforce and patterns that do not compile", () => {
    expect(InputSchema.safeParse({ type: "string", format: "email" }).success).toBe(false);
    expect(InputSchema.safeParse({ type: "string", pattern: "(" }).success).toBe(false);
    expect(() => parseRubric({ ...rubric(), inputSchema: { type: "object", oneOf: [] } })).toThrow(/inputSchema/);
  });
});

describe("evaluations with inputSchema", () => {
  it("fails a mismatching subject before ingestion or any judge, and records why", async () => {
    let calls = 0;
    const engine = new Engine({ fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    const ev = await engine.evaluate({ rubric: rubric({ type: "decision", provider: "typesafe" }), subject: { inputs: [{ type: "json", data: { recent_context: "어제 통화" } }, { type: "url", url: "https://example.com" }] } });
    expect(ev.status).toBe("failed");
    expect(ev.error).toBe("invalid input: $.utterance is required");
    expect(ev.inputErrors).toEqual([{ input: 0, path: "$.utterance", message: "is required" }]);
    expect(ev.evidence).toEqual([]);
    expect(ev.usage.decisionCalls).toBe(0);
    expect(calls).toBe(0);
    // Invalid input is terminal: the queue must not retry it as a transient failure.
    expect(transientErrors(ev)).toBeUndefined();
    expect((await engine.store.getEvaluation(ev.id))?.inputErrors).toHaveLength(1);
  });

  it("requires a json input when the rubric declares a schema, and runs normally when inputs match", async () => {
    const engine = new Engine();
    const missing = await engine.evaluate({ rubric: rubric(), subject: { inputs: [{ type: "text", text: "상담원 연결해 주세요." }] } });
    expect(missing).toMatchObject({ status: "failed", inputErrors: [{ input: null, path: "$" }] });
    const ok = await engine.evaluate({ rubric: rubric(), subject: { inputs: [{ type: "json", data: { utterance: "상담원 연결해 주세요." } }] } });
    expect(ok.status).toBe("completed");
    expect(ok.inputErrors).toBeUndefined();
    expect(ok.usage.decisionCalls).toBe(1);
  });

  it("counts invalid cases apart in a gold check instead of as disagreements", async () => {
    const report = await checkAgainstHumans(new Engine(), rubric(), [
      { name: "ok", inputs: [{ type: "json", data: { utterance: "연결해 주세요" } }], expected: { wants_agent: "yes" } },
      { name: "bad", inputs: [{ type: "json", data: { utterance: "" } }], expected: { wants_agent: "yes" } },
    ]);
    expect(report).toMatchObject({ failed: 1, invalidInput: 1, criteria: { wants_agent: { n: 1 } } });
    expect(report.results.find((r) => r.name === "bad")).toMatchObject({ inputErrors: [{ input: 0, path: "$.utterance" }], criteria: { wants_agent: { verdict: null, agrees: null } } });
  });
});
