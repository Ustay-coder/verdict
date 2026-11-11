import { describe, expect, it } from "vitest";
import { Engine, freezeRubric, MemoryStore } from "@verdict-ai/core";
import { createApp, envAuth, memoryLimiter, type HubLimits } from "../src/index.js";
import { hubLimits } from "../src/worker.js";

const card = { name: "Wants an agent", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary" }, threshold: 0.6 }] };

async function setup(opts: { limits?: HubLimits; adminKey?: string; github?: Parameters<typeof createApp>[0]["github"] } = {}) {
  const store = new MemoryStore();
  const app = createApp({ engine: new Engine({ store }), auth: envAuth({ VERDICT_API_KEYS: "ka:alice,kb:bob" }), adminKey: opts.adminKey, limits: opts.limits, github: opts.github, now: () => Date.parse("2026-11-09T00:00:00.000Z") });
  const call = (path: string, init: RequestInit & { key?: string; ip?: string } = {}) => app.request(`http://hub.test${path}`, {
    ...init, headers: { "content-type": "application/json", ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.ip ? { "cf-connecting-ip": init.ip } : {}) },
  });
  const v = await freezeRubric(card);
  const body = (slug = "agent") => JSON.stringify({ slug, version: { id: v.id, rubric: v.rubric }, license: "CC0-1.0" });
  const publish = (key = "ka", slug = "agent") => call("/v1/publications", { method: "POST", body: body(slug), key });
  return { app, call, publish, body, store, v };
}

describe("hub takedowns", () => {
  it("lets operators take any publication down with a public reason, and put back only what they took down", async () => {
    const t = await setup({ adminKey: "op" });
    const { publication } = await (await t.publish()).json() as { publication: { id: string } };
    const admin = (path: string, init: RequestInit = {}) => t.call(path, { ...init, key: "op" });

    const all = await (await admin("/v1/admin/publications?owner=alice")).json() as { data: Array<{ id: string; tenantId: string }> };
    expect(all.data).toEqual([expect.objectContaining({ id: publication.id, tenantId: "alice" })]);
    expect((await admin(`/v1/admin/publications/${publication.id}/takedown`, { method: "POST", body: JSON.stringify({ reason: " " }) })).status).toBe(400);
    expect((await admin("/v1/admin/publications/pub_nope/takedown", { method: "POST", body: JSON.stringify({ reason: "x" }) })).status).toBe(404);
    expect((await t.call(`/v1/admin/publications/${publication.id}/takedown`, { method: "POST", body: JSON.stringify({ reason: "x" }), key: "ka" })).status).toBe(401);

    const down = await admin(`/v1/admin/publications/${publication.id}/takedown`, { method: "POST", body: JSON.stringify({ reason: "contains personal data" }) });
    expect(await down.json()).toMatchObject({ publication: { withdrawnAt: "2026-11-09T00:00:00.000Z", takedown: { reason: "contains personal data", at: "2026-11-09T00:00:00.000Z" } } });
    const gone = await t.call("/v1/public/rubrics/alice/agent");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { type: "taken_down", message: `alice/agent at ${t.v.id} was taken down by the hub's operators on 2026-11-09: contains personal data` } });
    expect(await (await t.call("/hub/alice/agent")).text()).toContain("taken down by the hub&#39;s operators on 2026-11-09: contains personal data");
    expect((await (await t.call("/v1/public/rubrics")).json() as { data: unknown[] }).data).toEqual([]);
    // The author sees it in their own list, and cannot publish the same version again.
    expect((await (await t.call("/v1/publications", { key: "ka" })).json() as { data: Array<{ takedown?: unknown }> }).data[0]!.takedown).toBeDefined();
    const again = await t.publish();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { message: expect.stringMatching(/taken down .*; publish a new version instead$/) } });

    const restored = await admin(`/v1/admin/publications/${publication.id}/restore`, { method: "POST" });
    expect((await restored.json() as { publication: object }).publication).not.toHaveProperty("takedown");
    expect((await t.call("/v1/public/rubrics/alice/agent")).status).toBe(200);

    // An author's own withdrawal is not the operators' to undo.
    await t.call(`/v1/publications/${publication.id}`, { method: "DELETE", key: "ka" });
    const refused = await admin(`/v1/admin/publications/${publication.id}/restore`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringMatching(/was not taken down; its author withdrew it$/) } });
  });

  it("keeps admin routes closed without an admin key, and key management needs a key store", async () => {
    const closed = await setup();
    expect((await closed.call("/v1/admin/publications", { key: "anything" })).status).toBe(404);
    const open = await setup({ adminKey: "op" });
    expect((await open.call("/v1/admin/keys?tenant=t", { key: "op" })).status).toBe(404);
  });
});

describe("hub limits", () => {
  it("counts in fixed windows per key", () => {
    let now = 0;
    const limiter = memoryLimiter({ limit: 2, windowMs: 1000 }, () => now);
    expect([limiter.limit("a"), limiter.limit("a"), limiter.limit("a"), limiter.limit("b")]).toEqual([true, true, false, true]);
    now = 1000;
    expect(limiter.limit("a")).toBe(true);
  });

  it("limits public reads per client address with 429 and Retry-After", async () => {
    const t = await setup({ limits: { read: memoryLimiter({ limit: 2, windowMs: 60_000 }) } });
    expect((await t.call("/v1/public/rubrics", { ip: "1.1.1.1" })).status).toBe(200);
    expect((await t.call("/hub", { ip: "1.1.1.1" })).status).toBe(200);
    const limited = await t.call("/v1/public/rubrics/alice/agent", { ip: "1.1.1.1" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: { type: "rate_limited", message: "too many hub read requests; try again in a minute" } });
    expect((await t.call("/v1/public/rubrics", { ip: "2.2.2.2" })).status).toBe(200);
    // Tenant routes are not read-limited.
    expect((await t.call("/v1/publications", { ip: "1.1.1.1", key: "ka" })).status).toBe(200);
  });

  it("limits publishing per account, previews included, and sign-in before GitHub is asked", async () => {
    const t = await setup({ limits: { publish: memoryLimiter({ limit: 2, windowMs: 60_000 }) } });
    expect((await t.call("/v1/publications/preview", { method: "POST", body: t.body(), key: "ka" })).status).toBe(200);
    expect((await t.publish("ka")).status).toBe(201);
    expect((await t.publish("ka", "other")).status).toBe(429);
    expect((await t.publish("kb")).status).toBe(201);

    let asked = 0;
    const github = { clientId: "Iv1.c", fetch: (async () => { asked++; return Response.json({ id: 1, login: "carol" }); }) as typeof fetch };
    const keys = { createKey: async () => ({ id: "key_1", key: "vk_1", prefix: "vk" }), revokeKey: async () => true, listKeys: async () => [] };
    const app = createApp({ engine: new Engine({ store: new MemoryStore() }), keys, github, limits: { login: memoryLimiter({ limit: 1, windowMs: 60_000 }) } });
    const login = () => app.request("/v1/hub/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify({ githubToken: "t" }) });
    expect((await login()).status).toBe(201);
    expect((await login()).status).toBe(429);
    expect(asked).toBe(1);
  });

  it("are on by default and can be turned off", async () => {
    const on = await setup();
    const statuses = await Promise.all(Array.from({ length: 31 }, () => on.call("/v1/publications/preview", { method: "POST", body: on.body(), key: "ka" })));
    expect(statuses.filter((r) => r.status === 429)).toHaveLength(1);
    const off = await setup({ limits: {} });
    const unlimited = await Promise.all(Array.from({ length: 31 }, () => off.call("/v1/publications/preview", { method: "POST", body: off.body(), key: "ka" })));
    expect(unlimited.every((r) => r.status === 200)).toBe(true);
  });

  it("use Cloudflare's rate limiting bindings on Workers when bound", async () => {
    const seen: string[] = [];
    const limits = hubLimits({ HUB_READ_LIMITER: { limit: async ({ key }) => { seen.push(key); return { success: key !== "blocked" }; } } });
    expect(await limits.read!.limit("ok")).toBe(true);
    expect(await limits.read!.limit("blocked")).toBe(false);
    expect(seen).toEqual(["ok", "blocked"]);
    // Unbound limiters fall back to counters shared by the isolate.
    expect(hubLimits({}).login).toBe(hubLimits({}).login);
  });
});
