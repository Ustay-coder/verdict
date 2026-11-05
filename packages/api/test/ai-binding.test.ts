import { describe, expect, it } from "vitest";
import { buildEngine } from "../src/worker.js";

describe("worker AI binding", () => {
  it("routes the cloudflare decision provider through env.AI with the System One body", async () => {
    const calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
    const AI = { run: async (model: string, inputs: Record<string, unknown>) => { calls.push({ model, inputs }); return { answers: { k: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 42 } }; } };
    const { engine } = buildEngine({ AI, TYPESAFE_API_KEY: "unused" });
    const ev = await engine.evaluate({
      rubric: { name: "ai", defaultJudge: { type: "decision", provider: "cloudflare", model: "@cf/cloudflare/clef-flash" }, criteria: [{ id: "k", name: "K", scale: { type: "binary" } }] },
      subject: { inputs: [{ type: "text", text: "hello" }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0]!.inputs.model).toBe("clef-flash");
    expect((calls[0]!.inputs.questions as Record<string, { type: string }>).k.type).toBe("noul");
    expect(ev.criteria[0]!.score).toBe(1);
    expect(ev.usage.inputTokens).toBe(42);
  });
});
