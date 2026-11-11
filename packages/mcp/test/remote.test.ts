import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Engine } from "@verdict-ai/core";
import { createMcpServer } from "../src/index.js";

it("forwards each remote tool using SDK requests", async () => {
  const engine = new Engine();
  const rubric = await engine.createRubric({ name: "Remote", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "human", name: "Human", judge: { type: "human" } }] });
  const ev = await engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: "hello" }] } });
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.includes("calibration")) return Response.json({ overall: { n: 0 }, criteria: [] });
    if (path.includes("batches")) return Response.json({ ranking: [{ rank: 1 }], evaluations: [] });
    if (path.endsWith("tasks")) return Response.json({ data: ev.pendingTasks });
    if (path.endsWith("rubrics")) return Response.json({ ...rubric, data: [rubric] });
    return Response.json(ev);
  });
  vi.stubGlobal("fetch", fetch);
  const server = createMcpServer({ mode: "remote", apiUrl: "https://verdict.test", apiKey: "key" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }); expect(response.isError).not.toBe(true);
    return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    expect((await call("create_rubric", { rubric })).id).toBe(rubric.id);
    expect(await call("list_rubrics")).toHaveLength(1);
    expect((await call("calibration_report", { rubricId: rubric.id })).overall.n).toBe(0);
    const inputs = [{ type: "text", text: "hello" }];
    expect((await call("evaluate", { rubric, inputs })).id).toBe(ev.id);
    expect((await call("evaluate", { rubric: rubric.id, inputs, idempotencyKey: "e" })).replayed).toBe(false);
    const subjects = [{ name: "a", inputs }, { name: "b", inputs }];
    expect((await call("compare", { rubric, subjects })).ranking).toHaveLength(1);
    expect((await call("compare", { rubric, subjects, idempotencyKey: "b" })).ranking).toHaveLength(1);
    expect((await call("get_evaluation", { id: ev.id })).id).toBe(ev.id);
    expect((await call("submit_human_score", { evaluationId: ev.id, criterionId: "human", raterId: "bob", score: 1 })).id).toBe(ev.id);
    expect((await call("reaggregate", { evaluationId: ev.id, aggregation: {} })).id).toBe(ev.id);
    expect(await call("list_human_tasks")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(11);
  } finally { await client.close(); await server.close(); vi.unstubAllGlobals(); }
});
