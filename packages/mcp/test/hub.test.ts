import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildPublication, freezeRubric, listingOf, publicView, versionEntry, type Publication } from "@verdict-ai/core";
import { createMcpServer } from "../src/index.js";

const rubric = { name: "Wants an agent", defaultJudge: { type: "decision", provider: "mock", options: { normalized: 1 } }, criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.6 }] };

/** A hub that serves one card; `tamper` changes the rubric it sends without changing the id it names. */
async function fakeHub(tamper = false) {
  const v = await freezeRubric(rubric);
  const draft = (await buildPublication({ slug: "agent", version: { id: v.id, rubric: v.rubric }, license: "CC-BY-4.0", cases: [{ id: "c1", name: "c1", inputs: [{ type: "text", text: "상담원 연결" }], expected: { wants: "yes" }, visibility: "public", labelSource: "human" }] }, { owner: "alice", tenantId: "t1" })).publication!;
  const p: Publication = { ...draft, id: "pub_1", createdAt: "2026-11-09T00:00:00.000Z" };
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.startsWith("https://hub.example/v1/public/rubrics?")) return Response.json({ data: [listingOf(p)] });
    if (url.startsWith("https://hub.example/v1/public/rubrics/alice/agent")) {
      const view = publicView(p);
      return Response.json({ publication: tamper ? { ...view, version: { ...view.version, rubric: { ...view.version.rubric, name: "Changed" } } } : view, versions: [versionEntry(p)] });
    }
    return Response.json({ error: { type: "not_found", message: "no card" } }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { v, fetch, requests };
}

async function connect(opts: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(opts);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const body = (response.content as Array<{ text: string }>)[0]!.text;
    return { isError: response.isError === true, body, json: () => JSON.parse(body) };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

describe("hub MCP tools", () => {
  it("search, read and fork a card into local rubrics that evaluate can use, without sending a key", async () => {
    const hub = await fakeHub();
    const prev = process.env.VERDICT_API_KEY;
    process.env.VERDICT_API_KEY = "team-key";
    const m = await connect({ mode: "local", hubUrl: "https://hub.example/", fetch: hub.fetch });
    try {
      expect((await m.call("hub_search", { q: "agent", type: "noul" })).json()).toEqual([expect.objectContaining({ ref: `hub:alice/agent@${hub.v.id}`, license: "CC-BY-4.0", cases: 1 })]);
      expect(hub.requests[0]!.url).toBe("https://hub.example/v1/public/rubrics?q=agent&type=noul");

      const card = (await m.call("hub_get", { ref: "hub:alice/agent" })).json();
      expect(card).toMatchObject({ ref: `hub:alice/agent@${hub.v.id}`, license: "CC-BY-4.0", question: { name: "Wants an agent", threshold: 0.6 }, cases: { total: 1 }, versions: [{ versionId: hub.v.id }] });
      expect(JSON.stringify(card)).not.toContain("t1");

      const fork = (await m.call("fork_rubric", { ref: `hub:alice/agent@${hub.v.id}`, name: "My agent check" })).json();
      expect(fork).toMatchObject({ name: "My agent check", forkedFrom: { hub: "https://hub.example", versionId: hub.v.id, license: "CC-BY-4.0" }, publicCases: 1 });
      const ev = (await m.call("evaluate", { rubric: fork.id, inputs: [{ type: "text", text: "상담원 연결해 주세요" }] })).json();
      expect(ev.status).toBe("completed");
      expect(hub.requests.every((r) => r.authorization === null)).toBe(true);
    } finally {
      await m.close();
      if (prev === undefined) delete process.env.VERDICT_API_KEY; else process.env.VERDICT_API_KEY = prev;
    }
  });

  it("refuse a card that does not freeze to the version the hub names, and say when no hub is set", async () => {
    const hub = await fakeHub(true);
    const m = await connect({ mode: "local", hubUrl: "https://hub.example", fetch: hub.fetch });
    const none = await connect({ mode: "local", hubUrl: undefined, fetch: hub.fetch });
    try {
      for (const tool of ["hub_get", "fork_rubric"]) {
        const res = await m.call(tool, { ref: "hub:alice/agent" });
        expect(res.isError).toBe(true);
        expect(res.body).toMatch(/sent a rubric that freezes to rv_\w+, not rv_\w+/);
      }
      expect((await m.call("hub_get", { ref: "alice/agent" })).body).toMatch(/not a hub reference/);
      expect((await m.call("hub_get", { ref: "hub:alice/nothing" })).body).toMatch(/no card/);
      if (!process.env.VERDICT_HUB_URL) expect((await none.call("hub_search", {})).body).toMatch(/no hub configured/);
    } finally { await m.close(); await none.close(); }
  });
});
