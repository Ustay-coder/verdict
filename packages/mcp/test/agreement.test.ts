import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Engine } from "@verdict-ai/core";
import { registerAgreement } from "../src/agreement.js";

// The mock decision provider answers binary questions with P=0.1 for "spam", 0.9 for "yes".
const rubric = JSON.stringify({ name: "Good message", defaultJudge: { type: "decision", provider: "mock" }, aggregation: { passThreshold: 50 },
  criteria: [{ id: "good", name: "Good", scale: { type: "binary", labels: ["no", "yes"] }, anchors: { no: "bad", yes: "good" } }] });
const gold = [
  { name: "a", inputs: [{ type: "text", text: "spam" }], human: { passed: false, criteria: { good: false } } },
  { name: "b", inputs: [{ type: "text", text: "spam, but people liked it" }], human: { passed: true }, source: "ignored" },
].map((g) => JSON.stringify(g)).join("\n");

async function connect(engine?: Engine, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { "/w/rubric.json": rubric, "/w/gold.jsonl": gold, ...extra };
  const server = new McpServer({ name: "t", version: "1" });
  registerAgreement(server, { engine, read: async (p) => files[p] ?? Promise.reject(new Error(`missing ${p}`)), resolve: (p) => `/w/${p}`, dirname: () => "/w" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

it("re-reads the rubric file, checks it against the gold file and lists the disagreements", async () => {
  const { client, close } = await connect(new Engine());
  try {
    const response = await client.callTool({ name: "check_against_humans", arguments: { rubricPath: "rubric.json", gold: "gold.jsonl" } });
    expect(response.isError).not.toBe(true);
    const report = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    expect(report).toMatchObject({ items: 2, decided: 2, agreed: 1, askedHuman: 0, criteria: { good: { agreed: 1, n: 1, agreement: "100%" } } });
    expect(report.agreement).toBe("1/2 decided by Verdict agree with the humans (50%)");
    expect(report.labelSources).toEqual({ unspecified: 2 });
    expect(report.splits).toEqual({ unspecified: { agreed: 1, decided: 2, items: 2, agreement: "50%" } });
    expect(report.disagreements).toEqual([expect.objectContaining({ id: "b", name: "b", preview: "spam, but people liked it", verdict: { passed: false, criteria: {} } })]);
  } finally { await close(); }
});

it("refuses without a local engine or a rubric, and reports unreadable files as tool errors", async () => {
  const remote = await connect(undefined);
  try {
    const r = await remote.client.callTool({ name: "check_against_humans", arguments: { rubricPath: "rubric.json", gold: "gold.jsonl" } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/local engine/);
  } finally { await remote.close(); }
  const local = await connect(new Engine());
  try {
    const none = await local.client.callTool({ name: "check_against_humans", arguments: { gold: "gold.jsonl" } });
    expect((none.content as Array<{ text: string }>)[0]!.text).toMatch(/rubricPath or rubric/);
    const missing = await local.client.callTool({ name: "check_against_humans", arguments: { rubricPath: "nope.yaml", gold: "gold.jsonl" } });
    expect(missing.isError).toBe(true);
  } finally { await local.close(); }
});

it("lists cases that fail the rubric's inputSchema with their errors", async () => {
  const strict = JSON.stringify({ ...JSON.parse(rubric), inputSchema: { type: "object", required: ["text"] } });
  const cases = JSON.stringify([{ name: "bad", inputs: [{ type: "json", data: {} }], expected: { good: "yes" } }]);
  const { client, close } = await connect(new Engine(), { "/w/strict.json": strict, "/w/cases.json": cases });
  try {
    const response = await client.callTool({ name: "check_against_humans", arguments: { rubricPath: "strict.json", gold: "cases.json" } });
    const report = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    expect(report.failed).toBe(1);
    expect(report.invalidInput).toEqual([{ id: "bad", name: "bad", errors: [{ input: 0, path: "$.text", message: "is required" }] }]);
  } finally { await close(); }
});
