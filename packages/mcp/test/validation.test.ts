import { expect, it, vi } from "vitest";
import { Engine } from "@verdict-ai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

it("rejects missing rubric ids and scores outside the frozen scale before engine operations", async () => {
  const engine = new Engine();
  const evaluate = vi.spyOn(engine, "evaluate");
  const submit = vi.spyOn(engine, "submitScore");
  const server = createMcpServer({ engine, mode: "local" });
  const client = new Client({ name: "validation", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const missing = await client.callTool({ name: "evaluate", arguments: { rubric: "missing", inputs: [{ type: "text", text: "hello" }] } });
    expect(missing.isError).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    const ev = await engine.evaluate({ rubric: { name: "Human", scale: { type: "numeric", min: 1, max: 5 }, defaultJudge: { type: "human" }, criteria: [{ id: "a", name: "A" }] }, subject: { inputs: [{ type: "text", text: "hello" }] } });
    const outside = await client.callTool({ name: "submit_human_score", arguments: { evaluationId: ev.id, criterionId: "a", raterId: "alice", score: 6 } });
    expect(outside.isError).toBe(true);
    expect(outside.content).toEqual([{ type: "text", text: JSON.stringify({ error: "score must be between 1 and 5" }, null, 2) }]);
    expect(submit).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});
