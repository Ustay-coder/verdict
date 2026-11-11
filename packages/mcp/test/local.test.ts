import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

it("exposes local judging, human review and calibration through the MCP transport", async () => {
  const server = createMcpServer({ mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    const rubric = { name: "Review", defaultJudge: { type: "decision", provider: "mock", options: { normalized: 0.8 } }, criteria: [
      { id: "auto", name: "Automatic" }, { id: "person", name: "Human", judge: { type: "human", raters: ["alice"] } },
    ] };
    expect((await call("validate_rubric", { rubric })).valid).toBe(true);
    expect((await call("validate_rubric", { rubric: "name: incomplete" })).valid).toBe(false);
    const stored = await call("create_rubric", { rubric: JSON.stringify(rubric) });
    expect(await call("list_rubrics")).toEqual([expect.objectContaining({ id: stored.id })]);
    const inputs = [{ type: "text", text: "hello" }];
    const ev = await call("evaluate", { rubric: stored.id, inputs, name: "Subject" });
    expect(ev.status).toBe("pending_human");
    expect((await call("get_evaluation", { id: ev.id })).id).toBe(ev.id);
    expect(await call("get_evaluation", { id: "absent" })).toHaveProperty("error");
    expect(await call("list_human_tasks", { rater: "bob" })).toEqual([]);
    expect(await call("list_human_tasks", { rater: "alice" })).toHaveLength(1);
    expect(await call("list_human_tasks")).toHaveLength(1);
    const scored = await call("submit_human_score", { evaluationId: ev.id, criterionId: "person", raterId: "alice", score: 9 });
    expect(scored.status).toBe("completed");
    expect((await call("reaggregate", { evaluationId: ev.id, aggregation: { method: "min" }, persist: true })).score).toBeDefined();
    expect((await call("calibration_report", { rubricId: stored.id })).overall.evaluations).toBe(0);
    expect((await call("compare", { rubric, subjects: [{ name: "a", inputs }, { name: "b", inputs }] })).ranking).toHaveLength(2);
  } finally { await client.close(); await server.close(); }
});
