import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

it("accepts optional keys and reports replay metadata for evaluate and compare", async () => {
  const server = createMcpServer({ mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const rubric = { name: "Retry", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] };
    const inputs = [{ type: "text", text: "hello" }];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(result.isError).not.toBe(true);
      return JSON.parse(content[0]!.text);
    };
    const first = await call("evaluate", { rubric, inputs, idempotencyKey: "eval" });
    expect(first.replayed).toBe(false);
    const replay = await call("evaluate", { rubric, inputs, idempotencyKey: "eval" });
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    const args = { rubric, subjects: [{ name: "one", inputs }, { name: "two", inputs }], idempotencyKey: "compare" };
    const batch = await call("compare", args);
    expect(batch.replayed).toBe(false);
    expect(await call("compare", args)).toEqual({ ranking: batch.ranking, replayed: true });
  } finally { await client.close(); await server.close(); }
});
