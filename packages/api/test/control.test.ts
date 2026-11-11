import { describe, expect, it } from "vitest";
import { comparisonReportRequest, CONTROL_ACTIONS, Engine, freezeRubric, MemoryStore, runReportRequest, type AccessRequest, type Authorize, type Store } from "@verdict-ai/core";
import { createApp, ROUTE_GROUPS, routeGroups, type AppOptions, type Auth } from "../src/app.js";
import { localRuns } from "./control-fixtures.js";

const NOW = "2026-11-10T00:00:00.000Z";
const rubric = (question: string) => ({
  name: "Intent", defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "q", name: question, scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }],
});

const identities: Auth = {
  resolve: (key) => key === "sk_alice" ? { tenantId: "alice", actor: { kind: "key", id: "key_1", name: "laptop" } } : key === "sk_bob" ? "bob" : undefined,
};

async function setup(options: Partial<AppOptions> = {}) {
  let clock = Date.parse(NOW);
  const app = createApp({ engine: new Engine({ store: new MemoryStore() }), auth: identities, now: () => (clock += 1000), ...options });
  const call = async (method: string, path: string, body?: unknown, key = "sk_alice") => {
    const sent = body === undefined || method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: sent });
    const text = await res.text();
    // Routes that do not exist answer in plain text.
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) as any : undefined };
  };
  const [a, b, c] = await Promise.all(["First?", "Second?", "Third?"].map((q) => freezeRubric(rubric(q))));
  const upload = (v: { id: string; rubric: unknown }, name = "intent", project = "support-bot") => call("POST", `/v1/projects/${project}/rubrics/${name}/versions`, { id: v.id, rubric: v.rubric });
  const promote = (changes: unknown[], note?: string, env = "prod") => call("POST", `/v1/projects/support-bot/environments/${env}/promotions`, { changes, ...(note ? { note } : {}) });
  return { app, call, upload, promote, a: a!, b: b!, c: c! };
}

/** A project with one environment and versions a, b under `intent`. */
async function seeded(options: Partial<AppOptions> = {}) {
  const s = await setup(options);
  await s.call("POST", "/v1/projects", { name: "support-bot" });
  await s.call("POST", "/v1/projects/support-bot/environments", { name: "prod" });
  await s.upload(s.a); await s.upload(s.b);
  return s;
}

describe("projects and environments", () => {
  it("creates each once, lists them and refuses names that are not slugs", async () => {
    const { call } = await setup();
    expect(await call("POST", "/v1/projects", { name: "support-bot" })).toMatchObject({ status: 201, body: { name: "support-bot" } });
    expect(await call("POST", "/v1/projects", { name: "support-bot" })).toMatchObject({ status: 409, body: { error: { type: "already_exists" } } });
    expect((await call("POST", "/v1/projects", { name: "Support Bot" })).status).toBe(400);
    expect((await call("POST", "/v1/projects", "not json")).status).toBe(400);
    expect((await call("GET", "/v1/projects")).body.data).toEqual([{ name: "support-bot", createdAt: expect.any(String) }]);
    expect((await call("POST", "/v1/projects/nope/environments", { name: "prod" })).status).toBe(404);
    expect((await call("POST", "/v1/projects/support-bot/environments", { name: "prod" })).status).toBe(201);
    expect(await call("POST", "/v1/projects/support-bot/environments", { name: "prod" })).toMatchObject({ status: 409, body: { error: { type: "already_exists" } } });
    expect((await call("GET", "/v1/projects/support-bot/environments")).body.data).toEqual([{ project: "support-bot", name: "prod", createdAt: expect.any(String) }]);
    expect((await call("GET", "/v1/projects/nope/environments")).status).toBe(404);
    expect((await call("GET", "/v1/projects/support-bot/environments/prod")).body).toMatchObject({ name: "prod", pointers: [] });
    expect((await call("GET", "/v1/projects/support-bot/environments/dev")).status).toBe(404);
  });

  it("deletes only when the name is repeated, and keeps tenants apart", async () => {
    const { call, a, upload, promote } = await seeded();
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    expect((await call("GET", "/v1/projects", undefined, "sk_bob")).body.data).toEqual([]);
    expect((await call("GET", "/v1/projects/support-bot/environments/prod", undefined, "sk_bob")).status).toBe(404);
    expect((await call("DELETE", "/v1/projects/support-bot", { confirm: "support-bot" }, "sk_bob")).status).toBe(404);
    expect((await upload(a, "intent")).status).toBe(200);
    expect((await call("POST", "/v1/projects/support-bot/rubrics/intent/versions", { id: a.id, rubric: a.rubric }, "sk_bob")).status).toBe(404);
    expect((await call("DELETE", "/v1/projects/support-bot/environments/prod")).status).toBe(400);
    expect((await call("DELETE", "/v1/projects/support-bot/environments/prod", { confirm: "staging" })).status).toBe(400);
    expect((await call("DELETE", "/v1/projects/support-bot/environments/prod", { confirm: "prod" })).status).toBe(204);
    expect((await call("DELETE", "/v1/projects/support-bot/environments/prod", { confirm: "prod" })).status).toBe(404);
    // The environment is gone; what happened in it is still on record.
    expect((await call("GET", "/v1/projects/support-bot/history")).body.data).toHaveLength(1);
    expect((await call("DELETE", "/v1/projects/support-bot", {})).status).toBe(400);
    expect((await call("DELETE", "/v1/projects/support-bot", { confirm: "support-bot" })).status).toBe(204);
    expect((await call("GET", "/v1/projects/support-bot/history")).status).toBe(404);
  });
});

describe("versions", () => {
  it("stores what the rubric freezes to, once, under the name it was uploaded as", async () => {
    const { call, upload, a, b } = await seeded();
    expect(await upload(a)).toMatchObject({ status: 200, body: { created: false, version: { id: a.id, name: "intent", project: "support-bot" } } });
    expect(await upload(b, "urgency")).toMatchObject({ status: 201, body: { created: true, version: { name: "urgency" } } });
    expect(await call("POST", "/v1/projects/support-bot/rubrics/intent/versions", { id: a.id, rubric: b.rubric })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining(`freezes to ${b.id}`) } } });
    expect((await upload(a, "Not A Slug")).status).toBe(400);
    expect((await call("POST", "/v1/projects/support-bot/rubrics/intent/versions", { id: a.id, rubric: { name: "broken" } })).status).toBe(400);
    expect((await call("POST", "/v1/projects/support-bot/rubrics/intent/versions", { id: a.id, rubric: a.rubric, pad: "x".repeat(1_000_001) })).status).toBe(413);
    const forked = await call("POST", "/v1/projects/support-bot/rubrics/tone/versions", { id: b.id, rubric: b.rubric, parentVersionId: a.id, fork: { note: "sharper", changeKinds: ["question_text"] } });
    expect(forked.body.version).toMatchObject({ parentVersionId: a.id, fork: { note: "sharper", changeKinds: ["question_text"] } });
    expect((await call("GET", "/v1/projects/support-bot/rubrics")).body.data).toEqual([
      { name: "intent", versions: 2, updatedAt: expect.any(String) }, { name: "tone", versions: 1, updatedAt: expect.any(String) }, { name: "urgency", versions: 1, updatedAt: expect.any(String) },
    ]);
    const list = (await call("GET", "/v1/projects/support-bot/rubrics/intent/versions")).body.data;
    expect(list.map((v: { id: string }) => v.id).sort()).toEqual([a.id, b.id].sort());
    expect(list[0]).not.toHaveProperty("rubric");
    expect(list[0]).not.toHaveProperty("tenantId");
    const one = (await call("GET", `/v1/projects/support-bot/rubrics/intent/versions/${a.id}`)).body;
    expect((await freezeRubric(one.rubric)).id).toBe(a.id);
    expect((await call("GET", `/v1/projects/support-bot/rubrics/urgency/versions/${a.id}`)).status).toBe(404);
  });

  it("deletes a version only while no environment points at it", async () => {
    const { call, promote, a, b } = await seeded();
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    const path = (id: string) => `/v1/projects/support-bot/rubrics/intent/versions/${id}`;
    expect(await call("DELETE", path(a.id))).toMatchObject({ status: 409, body: { error: { type: "in_use" } } });
    expect((await call("DELETE", path(b.id))).status).toBe(204);
    expect((await call("DELETE", path(b.id))).status).toBe(404);
    expect((await promote([{ name: "intent", versionId: null, expected: a.id }])).status).toBe(200);
    expect((await call("DELETE", path(a.id))).status).toBe(204);
  });
});

describe("promotions", () => {
  it("moves a pointer only from the version the caller saw, and says where it is otherwise", async () => {
    const { call, promote, a, b } = await seeded();
    const first = await promote([{ name: "intent", versionId: a.id, expected: null }], "first release");
    expect(first).toMatchObject({ status: 200, body: { events: [{ name: "intent", from: null, to: a.id, kind: "promote", note: "first release", actor: { kind: "key", id: "key_1", name: "laptop" } }] } });
    expect(first.body.events[0].id).toMatch(/^prm_[0-9a-f]{20}$/);
    expect(first.body.events[0]).not.toHaveProperty("tenantId");
    expect(await promote([{ name: "intent", versionId: b.id, expected: null }])).toEqual({ status: 409, body: { error: { type: "pointer_conflict", message: expect.any(String), current: [{ name: "intent", versionId: a.id }] } } });
    expect((await promote([{ name: "intent", versionId: b.id, expected: a.id }])).status).toBe(200);
    expect((await call("GET", "/v1/projects/support-bot/environments/prod")).body.pointers).toEqual([{ name: "intent", versionId: b.id, updatedAt: expect.any(String) }]);
    const history = (await call("GET", "/v1/projects/support-bot/history?environment=prod&name=intent")).body.data;
    expect(history.map((e: { from: string | null; to: string }) => [e.from, e.to])).toEqual([[a.id, b.id], [null, a.id]]);
    expect((await call("GET", "/v1/projects/support-bot/history?limit=1")).body.data).toHaveLength(1);
    expect((await call("GET", "/v1/projects/support-bot/history?limit=0")).status).toBe(400);
  });

  it("applies every change of a request or none of them", async () => {
    const { call, upload, promote, a, b, c } = await seeded();
    await upload(a, "urgency");
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    const stale = await promote([{ name: "urgency", versionId: a.id, expected: null }, { name: "intent", versionId: b.id, expected: b.id.replace(/.$/, "0") }]);
    expect(stale).toMatchObject({ status: 409, body: { error: { current: [{ name: "urgency", versionId: null }, { name: "intent", versionId: a.id }] } } });
    expect((await call("GET", "/v1/projects/support-bot/environments/prod")).body.pointers).toHaveLength(1);
    // b is kept under intent, not under urgency; c was never uploaded.
    expect(await promote([{ name: "urgency", versionId: b.id, expected: null }])).toMatchObject({ status: 400, body: { error: { type: "unknown_version", message: expect.stringContaining(`${b.id} is not kept under urgency`) } } });
    expect((await promote([{ name: "intent", versionId: c.id, expected: a.id }])).body.error.type).toBe("unknown_version");
    expect((await promote([{ name: "intent", versionId: b.id, expected: a.id }], undefined, "staging")).status).toBe(404);
    expect((await promote([{ name: "urgency", versionId: a.id, expected: null }, { name: "intent", versionId: b.id, expected: a.id }])).status).toBe(200);
    expect((await call("GET", "/v1/projects/support-bot/history")).body.data).toHaveLength(3);
  });

  it("refuses requests that would change nothing or cannot be one unit", async () => {
    const { promote, a, b } = await seeded();
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    expect((await promote([])).status).toBe(400);
    expect((await promote([{ name: "intent", versionId: b.id }])).status).toBe(400);
    expect(await promote([{ name: "intent", versionId: a.id, expected: a.id }])).toMatchObject({ status: 400, body: { error: { message: `intent is already at ${a.id}` } } });
    expect((await promote([{ name: "urgency", versionId: null, expected: null }])).status).toBe(400);
    expect((await promote([{ name: "intent", versionId: b.id, expected: a.id }, { name: "intent", versionId: null, expected: a.id }])).status).toBe(400);
    expect((await promote(Array.from({ length: 21 }, (_, i) => ({ name: `r${i}`, versionId: a.id, expected: null })))).status).toBe(400);
  });

  it("rolls a pointer back to where its latest change found it, and back again", async () => {
    const { call, promote, a, b } = await seeded();
    const rollback = (expected: string | null, note?: string) => call("POST", "/v1/projects/support-bot/environments/prod/rollbacks", { name: "intent", expected, ...(note ? { note } : {}) });
    const pointer = async () => (await call("GET", "/v1/projects/support-bot/environments/prod")).body.pointers[0]?.versionId ?? null;
    expect((await rollback(null)).body.error.type).toBe("nothing_to_roll_back");
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    expect(await rollback(a.id)).toMatchObject({ status: 409, body: { error: { type: "nothing_to_roll_back" } } });
    await promote([{ name: "intent", versionId: b.id, expected: a.id }]);
    expect(await rollback(a.id)).toMatchObject({ status: 409, body: { error: { type: "pointer_conflict", current: [{ name: "intent", versionId: b.id }] } } });
    expect(await rollback(b.id, "bad answers")).toMatchObject({ status: 200, body: { event: { kind: "rollback", from: b.id, to: a.id, note: "bad answers" } } });
    expect(await pointer()).toBe(a.id);
    expect((await rollback(a.id)).body.event).toMatchObject({ from: a.id, to: b.id });
    expect(await pointer()).toBe(b.id);
    // Removing a pointer is a change like any other: rolling it back puts the pointer back.
    await promote([{ name: "intent", versionId: null, expected: b.id }]);
    expect((await rollback(null)).body.event).toMatchObject({ from: null, to: b.id });
    expect((await call("POST", "/v1/projects/support-bot/environments/staging/rollbacks", { name: "intent", expected: null })).status).toBe(404);
    const kinds = (await call("GET", "/v1/projects/support-bot/history")).body.data.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(["rollback", "unset", "rollback", "rollback", "promote", "promote"]);
  });

  it("does not roll back to a version that was deleted", async () => {
    const { call, promote, a, b } = await seeded();
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    await promote([{ name: "intent", versionId: b.id, expected: a.id }]);
    expect((await call("DELETE", `/v1/projects/support-bot/rubrics/intent/versions/${a.id}`)).status).toBe(204);
    expect(await call("POST", "/v1/projects/support-bot/environments/prod/rollbacks", { name: "intent", expected: b.id })).toMatchObject({ status: 409, body: { error: { type: "nothing_to_roll_back", message: expect.stringContaining("was deleted") } } });
  });

  it("ignores the history of an environment that was deleted and made again", async () => {
    const { call, promote, a, b } = await seeded();
    await promote([{ name: "intent", versionId: a.id, expected: null }]);
    await promote([{ name: "intent", versionId: null, expected: a.id }]);
    await call("DELETE", "/v1/projects/support-bot/environments/prod", { confirm: "prod" });
    await call("POST", "/v1/projects/support-bot/environments", { name: "prod" });
    expect((await call("POST", "/v1/projects/support-bot/environments/prod/rollbacks", { name: "intent", expected: null })).body.error.type).toBe("nothing_to_roll_back");
    expect(b.id).not.toBe(a.id);
  });
});

describe("reading an environment the way a service does", () => {
  it("returns every pointer with its rubric in one answer, and 304 while nothing changed", async () => {
    const { app, upload, promote, a, b } = await seeded();
    await upload(a, "urgency");
    await promote([{ name: "intent", versionId: a.id, expected: null }, { name: "urgency", versionId: a.id, expected: null }]);
    const read = (etag?: string, query = "?include=rubrics") => app.request(`/v1/projects/support-bot/environments/prod${query}`, { headers: { authorization: "Bearer sk_alice", ...(etag ? { "if-none-match": etag } : {}) } });
    const first = await read();
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const body = await first.json() as { pointers: Array<{ name: string; versionId: string; rubric: unknown }> };
    expect(body.pointers.map((p) => [p.name, p.versionId])).toEqual([["intent", a.id], ["urgency", a.id]]);
    // What arrives freezes to the id it is named by: a service can check it without trusting the wire.
    for (const p of body.pointers) expect((await freezeRubric(p.rubric)).id).toBe(p.versionId);

    const unchanged = await read(etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    // The plain listing is another answer, with its own tag.
    const plain = await read(undefined, "");
    expect(plain.headers.get("etag")).not.toBe(etag);
    expect((await plain.json() as { pointers: Array<Record<string, unknown>> }).pointers[0]).not.toHaveProperty("rubric");

    await promote([{ name: "intent", versionId: b.id, expected: a.id }]);
    const changed = await read(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await changed.json() as typeof body).pointers[0]).toMatchObject({ name: "intent", versionId: b.id });
    // Removing a pointer changes the answer too.
    await promote([{ name: "urgency", versionId: null, expected: a.id }]);
    expect((await read(changed.headers.get("etag")!)).status).toBe(200);
  });
});

describe("the place every request is allowed or refused", () => {
  const bodies: Record<string, unknown> = {
    "POST /v1/projects": { name: "p" },
    "POST /v1/projects/:project/environments": { name: "prod" },
    "POST /v1/projects/:project/environments/:environment/promotions": { changes: [{ name: "intent", versionId: "rv_00000000000000000000", expected: null }] },
    "POST /v1/projects/:project/environments/:environment/rollbacks": { name: "intent", expected: null },
  };

  it("refuses every route under /v1/projects before the store is touched", async () => {
    const asked: AccessRequest[] = [];
    const denyAll: Authorize = (request) => { asked.push(request); return { allow: false, reason: "forbidden" }; };
    // A store that fails on any use: a 403 therefore means the route asked first.
    const store = new MemoryStore();
    Object.defineProperty(store, "control", { value: new Proxy({}, { get: () => () => { throw new Error("the store was used before the request was allowed"); } }) });
    const { app, call } = await setup({ engine: new Engine({ store }), authorize: denyAll });
    const local = await localRuns();
    bodies["POST /v1/projects/:project/reports/runs"] = runReportRequest("intent", local.headRun.run, local.headRun.report, { version: local.head });
    bodies["POST /v1/projects/:project/reports/comparisons"] = comparisonReportRequest("intent", local.comparison);
    const routes = app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/v1/projects"));
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const route of routes) {
      const path = route.path.replace(":project", "p").replace(":environment", "prod").replace(":name", "intent").replace(":id", "rv_00000000000000000000").replace(":runId", "run_0");
      const res = await call(route.method, path, bodies[`${route.method} ${route.path}`] ?? {});
      expect({ route: `${route.method} ${route.path}`, status: res.status, type: res.body?.error?.type }).toEqual({ route: `${route.method} ${route.path}`, status: 403, type: "forbidden" });
    }
    // Removing a pointer travels on the promotion route but is its own action.
    const unset = await call("POST", "/v1/projects/p/environments/prod/promotions", { changes: [{ name: "urgency", versionId: null, expected: "rv_00000000000000000000" }] });
    expect(unset.status).toBe(403);
    expect(asked.every((r) => r.principal.tenantId === "alice" && r.principal.actor.name === "laptop")).toBe(true);
    // Every action is asked by some route.
    expect([...new Set(asked.map((r) => r.action))].sort()).toEqual([...CONTROL_ACTIONS].sort());
    expect(asked.find((r) => r.action === "pointer.unset")?.target).toEqual({ project: "p", environment: "prod", name: "urgency", versionId: null });
  });

  it("passes the reason of a refusal through, and refuses one rubric of a promotion without applying the others", async () => {
    const authorize: Authorize = ({ action, target }) => {
      // `details` say which limit; they add to the error and cannot rename the refusal.
      if (action === "environment.create" && target.environment !== "prod") return { allow: false, reason: "limit_exceeded", message: "the free plan has one environment", details: { limit: "environments", max: 1, used: 1, type: "forbidden", message: "x" } };
      if (action === "pointer.promote" && target.name === "urgency") return { allow: false, reason: "approval_required" };
      return { allow: true };
    };
    const { call, upload, promote, a } = await seeded({ authorize });
    expect(await call("POST", "/v1/projects/support-bot/environments", { name: "staging" })).toEqual({ status: 403, body: { error: { type: "limit_exceeded", message: "the free plan has one environment", limit: "environments", max: 1, used: 1 } } });
    await upload(a, "urgency");
    expect(await promote([{ name: "intent", versionId: a.id, expected: null }, { name: "urgency", versionId: a.id, expected: null }])).toMatchObject({ status: 403, body: { error: { type: "approval_required", message: expect.any(String) } } });
    expect((await call("GET", "/v1/projects/support-bot/environments/prod")).body.pointers).toEqual([]);
  });

  it("names an unnamed key as the actor when auth only knows the tenant", async () => {
    const { call, a } = await setup();
    const as = (method: string, path: string, body?: unknown) => call(method, path, body, "sk_bob");
    await as("POST", "/v1/projects", { name: "p" });
    await as("POST", "/v1/projects/p/environments", { name: "prod" });
    await as("POST", "/v1/projects/p/rubrics/intent/versions", { id: a.id, rubric: a.rubric });
    const done = await as("POST", "/v1/projects/p/environments/prod/promotions", { changes: [{ name: "intent", versionId: a.id, expected: null }] });
    expect(done.body.events[0].actor).toEqual({ kind: "key" });
  });
});

describe("on a database", () => {
  it("runs the same flow on SQLite and records the stored key's name as who did it", async () => {
    const { fromSqliteFile } = await import("@verdict-ai/db/sqlite");
    const h = await fromSqliteFile(":memory:");
    const { key, id } = await h.auth.createKey("acme", "release-bot");
    const app = createApp({ engine: new Engine({ store: h.store }), auth: h.auth });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: res.status === 204 ? undefined : await res.json() as any };
    };
    const [a, b] = await Promise.all([freezeRubric(rubric("First?")), freezeRubric(rubric("Second?"))]);
    expect((await call("POST", "/v1/projects", { name: "bot" })).status).toBe(201);
    expect((await call("POST", "/v1/projects/bot/environments", { name: "prod" })).status).toBe(201);
    for (const v of [a, b]) expect((await call("POST", "/v1/projects/bot/rubrics/intent/versions", { id: v.id, rubric: v.rubric })).status).toBe(201);
    expect((await call("GET", "/v1/projects/bot/rubrics")).body.data).toEqual([{ name: "intent", versions: 2, updatedAt: expect.any(String) }]);
    const promotions = "/v1/projects/bot/environments/prod/promotions";
    expect((await call("POST", promotions, { changes: [{ name: "intent", versionId: a.id, expected: null }] })).status).toBe(200);
    expect((await call("POST", promotions, { changes: [{ name: "intent", versionId: b.id, expected: null }] })).body.error).toMatchObject({ type: "pointer_conflict", current: [{ name: "intent", versionId: a.id }] });
    expect((await call("POST", promotions, { changes: [{ name: "intent", versionId: b.id, expected: a.id }] })).status).toBe(200);
    expect((await call("DELETE", `/v1/projects/bot/rubrics/intent/versions/${b.id}`)).body.error.type).toBe("in_use");
    expect((await call("POST", "/v1/projects/bot/environments/prod/rollbacks", { name: "intent", expected: b.id })).body.event).toMatchObject({ kind: "rollback", to: a.id });
    const history = (await call("GET", "/v1/projects/bot/history")).body.data;
    expect(history.map((e: { kind: string }) => e.kind)).toEqual(["rollback", "promote", "promote"]);
    expect(history.every((e: { actor: unknown }) => JSON.stringify(e.actor) === JSON.stringify({ kind: "key", id, name: "release-bot" }))).toBe(true);
  }, 30000);
});

describe("what a server that knows people needs from the seams", () => {
  it("hands the request to auth, and what auth established to authorize", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    // The key belongs to a person; the request says which of their organizations it is about. A browser sends no key.
    const auth: Auth = {
      resolve: (key, request) => {
        const org = request?.headers.get("x-verdict-org") ?? "personal";
        if (key === "sk_person" && ["personal", "acme"].includes(org)) return { tenantId: `org:${org}`, actor: { kind: "user", id: "u_1", name: "Alice" }, claims: { role: org === "acme" ? "viewer" : "admin" } };
        if (!key && request?.headers.get("cookie") === "session=s1") return { tenantId: "org:personal", actor: { kind: "user", id: "u_1", name: "Alice" }, claims: { role: "admin", via: "session" } };
        return undefined;
      },
    };
    const authorize: Authorize = ({ principal, action }) => {
      seen.push(principal.claims);
      return principal.claims?.role === "viewer" && !action.endsWith(".read") ? { allow: false, reason: "forbidden" } : { allow: true };
    };
    const app = createApp({ engine: new Engine({ store: new MemoryStore() }), auth, authorize });
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const key = { authorization: "Bearer sk_person" };
    expect((await call("POST", "/v1/projects", key, { name: "mine" })).status).toBe(201);
    expect((await call("POST", "/v1/projects", { ...key, "x-verdict-org": "acme" }, { name: "theirs" })).status).toBe(403);
    expect((await call("GET", "/v1/projects", { ...key, "x-verdict-org": "acme" })).status).toBe(200);
    expect((await call("GET", "/v1/projects", { ...key, "x-verdict-org": "elsewhere" })).status).toBe(401);
    // Each organization is its own tenant: the same key sees different projects.
    expect((await (await call("GET", "/v1/projects", key)).json() as { data: unknown[] }).data).toHaveLength(1);
    expect((await (await call("GET", "/v1/projects", { ...key, "x-verdict-org": "acme" })).json() as { data: unknown[] }).data).toEqual([]);
    expect((await call("GET", "/v1/projects", { cookie: "session=s1" })).status).toBe(200);
    expect((await call("GET", "/v1/projects", {})).status).toBe(401);
    expect(seen.at(-1)).toEqual({ role: "admin", via: "session" });
    // The person's name is what history records.
    await call("POST", "/v1/projects/mine/environments", key, { name: "prod" });
    const a = await freezeRubric(rubric("First?"));
    await call("POST", "/v1/projects/mine/rubrics/intent/versions", key, { id: a.id, rubric: a.rubric });
    const promoted = await (await call("POST", "/v1/projects/mine/environments/prod/promotions", key, { changes: [{ name: "intent", versionId: a.id, expected: null }] })).json() as { events: Array<{ actor: unknown }> };
    expect(promoted.events[0]!.actor).toEqual({ kind: "user", id: "u_1", name: "Alice" });
  });

  it("announces a sign-in the server runs itself, and nothing when it does not", async () => {
    const plain = await setup();
    expect((await plain.call("GET", "/v1/hub/config")).body).toEqual({ github: null, publishing: "tenant" });
    const cloud = await setup({ signIn: { kind: "browser", start: "/v1/auth/device", token: "/v1/auth/device/token" } });
    expect((await cloud.call("GET", "/v1/hub/config")).body).toEqual({ github: null, publishing: "tenant", signIn: { kind: "browser", start: "/v1/auth/device", token: "/v1/auth/device/token" } });
  });
});

describe("route groups", () => {
  it("serves only the groups an app was built with", async () => {
    const cloud = await setup({ routes: ["hub", "control"] });
    expect((await cloud.call("GET", "/v1/projects")).status).toBe(200);
    expect((await cloud.call("GET", "/v1/hub/config")).status).toBe(200);
    expect((await cloud.call("GET", "/v1/rubrics")).status).toBe(404);
    expect((await cloud.call("POST", "/v1/evaluations", { rubric: "r", inputs: [] })).status).toBe(404);
    expect((await cloud.call("POST", "/v1/batches", {})).status).toBe(404);
    expect((await cloud.call("GET", "/v1/tasks")).status).toBe(404);
    const paths = Object.keys((await cloud.call("GET", "/v1/openapi.json")).body.paths);
    expect(paths.some((p) => p.startsWith("/v1/evaluations") || p.startsWith("/v1/rubrics") || p.startsWith("/v1/batches") || p.startsWith("/v1/tasks"))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(["/v1/projects", "/v1/publications", "/v1/admin/keys"]));
    const engine = await setup({ routes: ["evaluations", "rubrics"] });
    expect((await engine.call("GET", "/v1/projects")).status).toBe(404);
    expect((await engine.call("GET", "/v1/publications")).status).toBe(404);
    expect((await engine.call("GET", "/v1/rubrics")).status).toBe(200);
    const all = Object.keys((await (await setup()).call("GET", "/v1/openapi.json")).body.paths);
    expect(all).toEqual(expect.arrayContaining(["/v1/evaluations", "/v1/rubrics", "/v1/projects/{project}/history"]));
  });

  it("reads the groups to serve from VERDICT_ROUTES and refuses names that are not groups", () => {
    expect(routeGroups(undefined)).toEqual(ROUTE_GROUPS);
    expect(routeGroups(" ")).toEqual(ROUTE_GROUPS);
    expect(routeGroups("hub, control")).toEqual(["hub", "control"]);
    expect(() => routeGroups("hub,projects")).toThrow("unknown route group projects");
  });

  it("answers 501 when the store cannot keep projects", async () => {
    const plain = new MemoryStore();
    Object.defineProperty(plain, "control", { value: undefined });
    const { call } = await setup({ engine: new Engine({ store: plain as Store }) });
    expect((await call("GET", "/v1/projects")).status).toBe(501);
  });
});
