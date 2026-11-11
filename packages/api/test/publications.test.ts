import { describe, expect, it } from "vitest";
import { Engine, freezeRubric, MemoryStore, type Store } from "@verdict-ai/core";
import { createApp } from "../src/app.js";

const card = {
  name: "Wants an agent", defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.6 }],
};

async function setup(store: Store = new MemoryStore()) {
  const tenants: Record<string, string> = { sk_alice: "alice", sk_bob: "bob" };
  const app = createApp({ engine: new Engine({ store }), auth: { resolve: (k) => tenants[k ?? ""] }, now: () => Date.parse("2026-11-08T00:00:00.000Z") });
  const call = (path: string, init: RequestInit = {}, key = "sk_alice") => app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const v = await freezeRubric(card);
  const body = { slug: "agent", version: { id: v.id, rubric: v.rubric }, license: "CC-BY-4.0", cases: [{ id: "c1", name: "c1", inputs: [{ type: "text", text: "connect me" }], expected: { wants: "yes" }, visibility: "public" }] };
  return { call, body, version: v };
}

describe("publication routes", () => {
  it("previews exactly the document it then stores, and publishing the same version again changes nothing", async () => {
    const { call, body } = await setup();
    const preview = await (await call("/v1/publications/preview", { method: "POST", body: JSON.stringify(body) })).json() as { ok: boolean; publication: Record<string, unknown>; warnings: unknown[] };
    expect(preview.ok).toBe(true);
    const created = await call("/v1/publications", { method: "POST", body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const { publication, created: isNew, warnings } = await created.json() as { publication: Record<string, unknown>; created: boolean; warnings: unknown[] };
    const { id, createdAt, ...stored } = publication;
    expect(stored).toEqual(preview.publication);
    expect(id).toMatch(/^pub_[0-9a-f]{20}$/);
    expect(createdAt).toBe("2026-11-08T00:00:00.000Z");
    expect(isNew).toBe(true);
    expect(warnings).toEqual(preview.warnings);
    expect(publication).toMatchObject({ owner: "alice", ref: "alice/agent" });
    const again = await call("/v1/publications", { method: "POST", body: JSON.stringify(body) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, publication: { id } });
  });

  it("answers a rejected preview with its issues, and refuses to store it", async () => {
    const { call, body } = await setup();
    const bad = { ...body, license: "none", cases: [{ ...body.cases[0], visibility: "private" }] };
    const preview = await call("/v1/publications/preview", { method: "POST", body: JSON.stringify(bad) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ok: false, issues: [{ path: "license" }, { path: "cases.0.visibility" }] });
    const rejected = await call("/v1/publications", { method: "POST", body: JSON.stringify(bad) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { type: "validation", issues: [{ path: "license" }, { path: "cases.0.visibility" }] } });
    expect((await call("/v1/publications", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await call("/v1/publications", { method: "POST", body: JSON.stringify({ ...body, note: "x".repeat(1_000_001) }) })).status).toBe(413);
  });

  it("lists and withdraws a tenant's own publications only; a withdrawn version is not republished", async () => {
    const { call, body } = await setup();
    const { publication } = await (await call("/v1/publications", { method: "POST", body: JSON.stringify(body) })).json() as { publication: { id: string } };
    expect((await (await call("/v1/publications", {}, "sk_bob")).json() as { data: unknown[] }).data).toEqual([]);
    expect((await call(`/v1/publications/${publication.id}`, { method: "DELETE" }, "sk_bob")).status).toBe(404);
    expect((await call(`/v1/publications/${publication.id}`, { method: "DELETE" })).status).toBe(204);
    const mine = await (await call("/v1/publications")).json() as { data: Array<{ id: string; withdrawnAt?: string }> };
    expect(mine.data).toEqual([expect.objectContaining({ id: publication.id, withdrawnAt: "2026-11-08T00:00:00.000Z" })]);
    const republished = await call("/v1/publications", { method: "POST", body: JSON.stringify(body) });
    expect(republished.status).toBe(409);
    expect((await call("/v1/publications", { method: "POST", body: JSON.stringify(body) }, "sk_nobody")).status).toBe(401);
  });

  it("says so when the server's store cannot keep publications", async () => {
    const plain = new MemoryStore() as unknown as Record<string, unknown>;
    const store = { ...Object.fromEntries(["putIdempotency", "getIdempotency", "putRubric", "getRubric", "listRubrics", "deleteRubric", "putEvaluation", "getEvaluation", "listEvaluations"].map((k) => [k, (plain[k] as (...a: unknown[]) => unknown).bind(plain)])) } as unknown as Store;
    const { call, body } = await setup(store);
    expect((await call("/v1/publications", { method: "POST", body: JSON.stringify(body) })).status).toBe(501);
  });
});
