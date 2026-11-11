import { describe, expect, it } from "vitest";
import { Engine, freezeRubric, MemoryStore } from "@verdict-ai/core";
import { createApp, type Auth, type KeyManager } from "../src/app.js";

/** Hashing is beside the point here; the database-backed manager is tested in @verdict-ai/db. */
class MemoryKeys implements Auth, KeyManager {
  keys = new Map<string, { id: string; tenantId: string; revoked: boolean }>();
  resolve(key: string | undefined) { const k = key ? this.keys.get(key) : undefined; return k && !k.revoked ? k.tenantId : undefined; }
  async createKey(tenantId: string) { const key = `vk_${this.keys.size + 1}`, id = `key_${this.keys.size + 1}`; this.keys.set(key, { id, tenantId, revoked: false }); return { id, key, prefix: key }; }
  async revokeKey(id: string, tenantId?: string) { const k = [...this.keys.values()].find((x) => x.id === id && (!tenantId || x.tenantId === tenantId)); if (!k) return false; k.revoked = true; return true; }
  async listKeys() { return []; }
}

/** A fake GitHub: tokens map to accounts; `app-token` is the only one minted for this OAuth app. */
function fakeGithub(accounts: Record<string, { id: number; login: string }>, calls: string[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    calls.push(`${init?.method ?? "GET"} ${url} ${headers.get("authorization")?.split(" ")[0] ?? ""}`);
    if (url === "https://api.github.com/user") {
      const account = accounts[headers.get("authorization")!.replace("Bearer ", "")];
      return account ? Response.json(account) : new Response("{}", { status: 401 });
    }
    if (url === "https://api.github.com/applications/Iv1.client/token") {
      if (headers.get("authorization") !== `Basic ${btoa("Iv1.client:shh")}`) return new Response("{}", { status: 401 });
      const token = (JSON.parse(String(init!.body)) as { access_token: string }).access_token;
      return accounts[token] && token.startsWith("app-") ? Response.json({ user: accounts[token] }) : new Response("{}", { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

const card = { name: "Wants an agent", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary" }, threshold: 0.6 }] };

async function setup(github: Parameters<typeof createApp>[0]["github"] | undefined) {
  const keys = new MemoryKeys(), store = new MemoryStore();
  const app = createApp({ engine: new Engine({ store }), auth: keys, keys, github, now: () => Date.parse("2026-11-08T00:00:00.000Z") });
  const call = (path: string, init: RequestInit = {}, key?: string) => app.request(path, { ...init, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  const login = async (githubToken: string) => call("/v1/hub/login", { method: "POST", body: JSON.stringify({ githubToken }) });
  const v = await freezeRubric(card);
  const publish = (key: string, slug = "agent") => call("/v1/publications", { method: "POST", body: JSON.stringify({ slug, version: { id: v.id, rubric: v.rubric }, license: "CC0-1.0" }) }, key);
  return { app, call, login, publish, keys, store };
}

describe("hub sign-in", () => {
  it("advertises the GitHub client id without a key, and nothing when sign-in is not configured", async () => {
    expect(await (await (await setup({ clientId: "Iv1.client" })).call("/v1/hub/config")).json()).toEqual({ github: { clientId: "Iv1.client" }, publishing: "github" });
    expect(await (await (await setup(undefined)).call("/v1/hub/config")).json()).toEqual({ github: null, publishing: "tenant" });
  });

  it("checks the token against this app when it has the client secret, issues a key bound to the GitHub id, and publishes under the login", async () => {
    const calls: string[] = [];
    const t = await setup({ clientId: "Iv1.client", clientSecret: "shh", fetch: fakeGithub({ "app-token": { id: 42, login: "alice" }, "other-app-token": { id: 42, login: "alice" } }, calls) });
    expect((await t.login("other-app-token")).status).toBe(401);
    const res = await t.login("app-token");
    expect(res.status).toBe(201);
    const session = await res.json() as { apiKey: string; keyId: string; handle: string; tenantId: string };
    expect(session).toMatchObject({ handle: "alice", tenantId: "gh:42", keyId: "key_1" });
    expect(calls.every((c) => c.startsWith("POST https://api.github.com/applications/Iv1.client/token Basic"))).toBe(true);
    expect(await (await t.call("/v1/hub/me", {}, session.apiKey)).json()).toEqual({ tenantId: "gh:42", handle: "alice", github: { id: 42, login: "alice" } });
    const published = await (await t.publish(session.apiKey)).json() as { publication: { ref: string; tenantId: string } };
    expect(published.publication).toMatchObject({ ref: "alice/agent", tenantId: "gh:42" });
    // The GitHub token is not kept anywhere on the hub.
    expect(JSON.stringify([...t.store.publishers.values(), ...t.store.publications.values()])).not.toContain("app-token");
  });

  it("falls back to reading the account when no secret is set, and says when GitHub cannot be asked", async () => {
    const t = await setup({ clientId: "Iv1.client", fetch: fakeGithub({ tok: { id: 7, login: "bob" } }) });
    expect(await (await t.login("tok")).json()).toMatchObject({ handle: "bob", tenantId: "gh:7" });
    expect((await t.login("nope")).status).toBe(401);
    const down = await setup({ clientId: "Iv1.client", fetch: (async () => { throw new Error("ENOTFOUND"); }) as typeof fetch });
    const res = await down.login("tok");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/could not reach GitHub.*ENOTFOUND/) } });
  });

  it("only lets signed-in GitHub accounts publish once sign-in is configured, keeps a ref with its first account, and revokes keys", async () => {
    const accounts = { a1: { id: 1, login: "carol" }, a2: { id: 2, login: "carol" } };
    const t = await setup({ clientId: "Iv1.client", fetch: fakeGithub(accounts) });
    const { key: teamKey } = await t.keys.createKey("team-a");
    expect((await t.publish(teamKey)).status).toBe(403);
    const first = await (await t.login("a1")).json() as { apiKey: string; keyId: string };
    expect((await t.publish(first.apiKey)).status).toBe(201);
    // Account 1 renamed itself; account 2 now holds the login "carol". The old ref stays with account 1.
    const second = await (await t.login("a2")).json() as { apiKey: string };
    const taken = await t.publish(second.apiKey);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { message: "carol/agent belongs to another account; choose another slug" } });
    expect((await t.publish(second.apiKey, "agent-2")).status).toBe(201);
    expect((await t.call(`/v1/hub/keys/${first.keyId}`, { method: "DELETE" }, second.apiKey)).status).toBe(404);
    expect((await t.call(`/v1/hub/keys/${first.keyId}`, { method: "DELETE" }, first.apiKey)).status).toBe(204);
    expect((await t.call("/v1/hub/me", {}, first.apiKey)).status).toBe(401);
  });

  it("refuses sign-in where it cannot work", async () => {
    expect((await (await setup(undefined)).login("x")).status).toBe(501);
    const noKeys = createApp({ engine: new Engine(), github: { clientId: "Iv1.client" } });
    expect((await noKeys.request("/v1/hub/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ githubToken: "x" }) })).status).toBe(501);
  });
});
