/**
 * What a host and its model see of each tool is the whole of what they have to choose and call it by. This holds
 * every tool to saying enough: a title, a description that says what comes back, a description for every parameter,
 * and hints about what the tool does to the world that match what it does.
 */
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

async function listed() {
  const server = createMcpServer({ mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? "" }; }
  finally { await client.close(); await server.close(); }
}

it("describes every tool and every parameter a caller has to fill in", async () => {
  const { tools } = await listed();
  expect(tools.map((t) => t.name).sort()).toEqual(["calibration_report", "check_against_humans", "compare", "create_rubric", "evaluate", "fork_rubric", "get_evaluation", "hub_get", "hub_search", "list_human_tasks", "list_rubrics", "reaggregate", "submit_human_score", "validate_rubric"]);
  for (const tool of tools) {
    expect(tool.title, tool.name).toBeTruthy();
    // Long enough to say what the tool does and what it returns; the shortest used to be twenty characters.
    expect(tool.description!.length, tool.name).toBeGreaterThanOrEqual(100);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      expect((schema as { description?: string }).description, `${tool.name}.${name}`).toBeTruthy();
    }
  }
});

it("says of every tool whether it only reads, and gets it right", async () => {
  const { tools } = await listed();
  const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const tool of tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) expect(typeof hints[tool.name]?.[hint], `${tool.name}.${hint}`).toBe("boolean");
    // Nothing here deletes or overwrites what cannot be had back.
    expect(hints[tool.name]!.destructiveHint, tool.name).toBe(false);
  }
  const readOnly = tools.filter((t) => t.annotations!.readOnlyHint).map((t) => t.name).sort();
  expect(readOnly).toEqual(["calibration_report", "get_evaluation", "hub_get", "hub_search", "list_human_tasks", "list_rubrics", "validate_rubric"]);
  // Reaching a hub or a model provider is the open world; reading this server's own store is not.
  const outward = tools.filter((t) => t.annotations!.openWorldHint).map((t) => t.name).sort();
  expect(outward).toEqual(["check_against_humans", "compare", "evaluate", "fork_rubric", "hub_get", "hub_search"]);
});

it("holds the read-only hint to what the tools do: a read-only call leaves the store as it was", async () => {
  const server = createMcpServer({ mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text) as unknown;
  try {
    const rubric = { name: "Kept", defaultJudge: { type: "decision", provider: "mock", options: { normalized: 0.8 } }, criteria: [{ id: "a", name: "A" }] };
    await call("validate_rubric", { rubric });
    expect(await call("list_rubrics")).toEqual([]);
    const stored = await call("create_rubric", { rubric }) as { id: string };
    const evaluation = await call("evaluate", { rubric: stored.id, inputs: [{ type: "text", text: "hello" }] }) as { id: string };
    const before = JSON.stringify([await call("list_rubrics"), await call("get_evaluation", { id: evaluation.id })]);
    await call("calibration_report", { rubricId: stored.id }); await call("list_human_tasks"); await call("validate_rubric", { rubric });
    // A what-if that is not asked to persist changes nothing either.
    await call("reaggregate", { evaluationId: evaluation.id, aggregation: { method: "min" } });
    expect(JSON.stringify([await call("list_rubrics"), await call("get_evaluation", { id: evaluation.id })])).toBe(before);
  } finally { await client.close(); await server.close(); }
});

it("tells a host, in the server's instructions, the order the tools are used in", async () => {
  const { instructions } = await listed();
  for (const name of ["validate_rubric", "create_rubric", "evaluate", "compare", "list_human_tasks", "submit_human_score", "hub_search", "fork_rubric"]) expect(instructions, name).toContain(name);
});
