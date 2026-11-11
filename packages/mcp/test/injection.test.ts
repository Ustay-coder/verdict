import { expect, it, vi } from "vitest";
import { Engine } from "@verdict-ai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

it("uses the supplied engine and converts rejected operations to MCP error content", async () => {
  const engine = new Engine();
  const failure = vi.spyOn(engine, "createRubric").mockRejectedValue(new Error("storage unavailable"));
  const server = createMcpServer({ engine, mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({ name: "create_rubric", arguments: { rubric: { name: "Example", criteria: [{ id: "a", name: "A" }] } } });
    expect(failure).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "storage unavailable" }, null, 2) }]);
  } finally { await client.close(); await server.close(); }
});
