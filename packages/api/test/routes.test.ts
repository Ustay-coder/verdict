import { expect, it, vi } from "vitest";
import { Engine } from "@verdict-ai/core";
import { createApp, envAuth, type KeyManager } from "../src/app.js";

it("keeps admin authorization separate from tenant keys and handles the full key lifecycle", async () => {
  const keys: KeyManager = {
    createKey: vi.fn(async () => ({ id: "k", key: "secret", prefix: "prefix" })),
    listKeys: vi.fn(async () => []), revokeKey: vi.fn(async id => id === "k"),
  };
  const app = createApp({ engine: new Engine(), keys, adminKey: "admin", auth: { resolve: () => undefined } });
  const call = (path: string, method = "GET", body?: unknown, key = "admin") => app.request(path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect((await call("/v1/admin/keys", "POST", { tenantId: "t", name: "Key" }, "wrong")).status).toBe(401);
  expect((await call("/v1/admin/keys", "POST", { tenantId: "t", name: "Key" })).status).toBe(201);
  expect(keys.createKey).toHaveBeenCalledWith("t", "Key");
  expect((await call("/v1/admin/keys?tenant=t")).status).toBe(200);
  expect(keys.listKeys).toHaveBeenCalledWith("t");
  expect((await call("/v1/admin/keys")).status).toBe(400);
  expect((await call("/v1/admin/keys/missing", "DELETE")).status).toBe(404);
  expect((await call("/v1/admin/keys/k", "DELETE")).status).toBe(204);
  expect((await call("/v1/rubrics")).status).toBe(401);
  expect((await createApp({ engine: new Engine() }).request("/v1/admin/keys")).status).toBe(404);
});

it("supports environment keys, discovery, rubric replacement and deletion", async () => {
  const auth = envAuth({ VERDICT_API_KEYS: "one:t1,two" });
  expect(await auth.resolve("one")).toBe("t1"); expect(await auth.resolve("two")).toBe("default");
  expect(await auth.resolve(undefined)).toBeUndefined(); expect(await auth.resolve("bad")).toBeUndefined();
  const app = createApp({ engine: new Engine(), auth });
  const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { "x-api-key": "one", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect((await app.request("/")).status).toBe(200);
  expect((await (await app.request("/v1/openapi.json")).json()).openapi).toBe("3.1.0");
  const rubric = { name: "Original", criteria: [{ id: "a", name: "A" }] };
  const r = await (await call("/v1/rubrics", "POST", rubric)).json();
  expect((await call(`/v1/rubrics/${r.id}`, "PUT", { ...rubric, name: "Updated" })).status).toBe(200);
  expect((await (await call(`/v1/rubrics/${r.id}`)).json()).name).toBe("Updated");
  expect((await call(`/v1/rubrics/${r.id}`, "DELETE")).status).toBe(204);
  expect((await call(`/v1/rubrics/${r.id}`, "DELETE")).status).toBe(404);
  expect((await call("/v1/rubrics/missing", "PUT", rubric)).status).toBe(404);
});
