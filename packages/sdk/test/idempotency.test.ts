import { expect, it } from "vitest";
import { Verdict, VerdictError } from "../src/index.js";

it("passes optional keys without changing create return shapes and exposes explicit replay metadata", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const client = new Verdict({ fetch: async (url, init) => {
    requests.push({ path: String(url), init });
    const data = String(url).endsWith("/batches") ? { evaluations: [], ranking: [] } : { id: "eval_1", status: "running", url: "/v1/evaluations/eval_1" };
    return Response.json(data, { headers: { "Idempotency-Replayed": "true" } });
  } });
  const params = { rubric: "rub_1", inputs: [{ type: "text" as const, text: "hello" }] };
  const created = await client.evaluations.create(params, { idempotencyKey: "retry" });
  expect(created).toEqual({ id: "eval_1", status: "running", url: "/v1/evaluations/eval_1" });
  expect(new Headers(requests[0]!.init?.headers).get("Idempotency-Key")).toBe("retry");
  expect(await client.evaluations.createAsync(params, { idempotencyKey: "async" })).toEqual(created);
  expect(JSON.parse(String(requests[1]!.init?.body)).async).toBe(true);
  expect(new Headers(requests[1]!.init?.headers).get("Idempotency-Key")).toBe("async");
  expect(await client.evaluations.createIdempotent(params, "retry")).toEqual({ evaluation: created, replayed: true });
  const batch = { rubric: "rub_1", subjects: [{ inputs: params.inputs }] };
  expect(await client.batches.create(batch, { idempotencyKey: "batch" })).toEqual({ evaluations: [], ranking: [] });
  expect(new Headers(requests[3]!.init?.headers).get("Idempotency-Key")).toBe("batch");
  expect(await client.batches.createIdempotent(batch, "batch")).toEqual({ evaluations: [], ranking: [], replayed: true });
});

it("defaults replayed to false and propagates conflict errors", async () => {
  const params = { rubric: "rub_1" };
  const client = new Verdict({ fetch: async () => Response.json({ id: "eval_1" }, { status: 201 }) });
  expect((await client.evaluations.createIdempotent(params, "retry")).replayed).toBe(false);
  const conflict = new Verdict({ fetch: async () => Response.json({ error: { type: "idempotency_conflict", message: "changed request" } }, { status: 409 }) });
  await expect(conflict.evaluations.createIdempotent(params, "retry")).rejects.toMatchObject({ status: 409, type: "idempotency_conflict" });
  await expect(conflict.batches.createIdempotent({ rubric: "rub_1", subjects: [] }, "retry")).rejects.toBeInstanceOf(VerdictError);
});
