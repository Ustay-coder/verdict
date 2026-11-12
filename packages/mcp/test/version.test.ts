import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";
import { MINIMUM_NODE, nodeTooOld } from "../src/package-version.js";

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

it("describes itself to the MCP registry with the name and version npm has", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
  const pkg = read("package.json") as { name: string; version: string; mcpName: string };
  const server = read("server.json") as { name: string; version: string; description: string; packages: { registryType: string; identifier: string; version: string; transport: { type: string } }[] };
  // The registry checks that the published package names this server, and that npm has the version it is told.
  expect(server.name).toBe(pkg.mcpName);
  expect(server.name).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  expect(server.version).toBe(pkg.version);
  expect(server.packages).toEqual([expect.objectContaining({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } })]);
  // The registry's schema refuses a longer description.
  expect(server.description.length).toBeLessThanOrEqual(100);
});

it("refuses an older Node with one sentence, and takes the minimum from package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
  expect(`>=${MINIMUM_NODE}`).toBe(pkg.engines.node);
  expect(nodeTooOld("20.20.2")).toBe(`Verdict needs Node ${MINIMUM_NODE} or newer, and this is Node 20.20.2. Install a newer Node (https://nodejs.org) and run the command again.`);
  expect(nodeTooOld(process.versions.node)).toBeUndefined();
});

it("names the repository's owner as the maintainer of its listing on Glama", () => {
  // Glama reads glama.json at the root of the repository to know who may manage the server's page there.
  const glama = JSON.parse(readFileSync(new URL("../../../glama.json", import.meta.url), "utf8")) as { $schema: string; maintainers: string[] };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { repository: { url: string } };
  const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)![1];
  expect(glama.$schema).toBe("https://glama.ai/mcp/schemas/server.json");
  expect(glama.maintainers).toEqual([owner]);
});
