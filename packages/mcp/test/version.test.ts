import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

it("tells a client the version it was published as", async () => {
  const server = createMcpServer({ mode: "local" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const published = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    expect(client.getServerVersion()).toMatchObject({ name: "verdict", version: published });
  } finally { await client.close(); await server.close(); }
});
