import { describe, expect, it, vi } from "vitest";
import { freezeRubric } from "@verdict-ai/core";
import { Verdict, VerdictError } from "../src/index.js";

const rubric = (question: string) => ({
  name: "Intent", defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "q", name: question, scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }],
});

/** A server holding one environment; tests change what it runs and whether it answers. */
async function setup(options: { fallback?: boolean; refreshMs?: number; timeoutMs?: number } = {}) {
  const [a, b] = await Promise.all([freezeRubric(rubric("First?")), freezeRubric(rubric("Second?"))]);
  const state = { pointers: [{ name: "intent", versionId: a!.id, rubric: a!.rubric as unknown }], down: false as false | "error" | "hang" | "refuse", clock: 0 };
  const requests: Array<{ url: string; etag: string | null; key: string | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), etag: headers.get("if-none-match"), key: headers.get("authorization") });
    if (state.down === "error") throw new Error("connection refused");
    if (state.down === "hang") return new Promise<Response>(() => undefined);
    if (state.down === "refuse") return Response.json({ error: { type: "forbidden", message: "this key may not read prod" } }, { status: 403 });
    const etag = `"${state.pointers.map((p) => p.versionId).join(",")}"`;
    if (headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return Response.json({ name: "prod", pointers: state.pointers }, { headers: { etag } });
  });
  const errors: unknown[] = [];
  const client = new Verdict({ baseUrl: "https://verdict.example", apiKey: "sk_service", fetch });
  const prod = client.environment({
    project: "support bot", environment: "prod", refreshMs: options.refreshMs ?? 60_000, timeoutMs: options.timeoutMs ?? 2_000, now: () => state.clock,
    onError: (e) => errors.push(e), ...(options.fallback ? { fallback: { intent: rubric("Spare?") } } : {}),
  });
  return { prod, state, requests, errors, a: a!, b: b!, spare: (await freezeRubric(rubric("Spare?"))).id };
}

describe("reading what an environment runs", () => {
  it("keeps the answer and asks again only after the interval, getting 304 while nothing changed", async () => {
    const t = await setup();
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.a.id, source: "server", rubric: { name: "Intent" } });
    expect(t.requests).toEqual([{ url: "https://verdict.example/v1/projects/support%20bot/environments/prod?include=rubrics", etag: null, key: "Bearer sk_service" }]);
    t.state.clock = 59_999;
    await t.prod.rubric("intent");
    expect(t.requests).toHaveLength(1);
    t.state.clock = 60_000;
    expect((await t.prod.rubric("intent")).source).toBe("server");
    expect(t.requests[1]!.etag).toBe(`"${t.a.id}"`);
    // A promotion is picked up by the first call after the interval.
    t.state.pointers = [{ name: "intent", versionId: t.b.id, rubric: t.b.rubric }];
    expect((await t.prod.rubric("intent")).versionId).toBe(t.a.id);
    t.state.clock = 120_000;
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.b.id, source: "server" });
    expect(t.errors).toEqual([]);
  });

  it("asks once when many calls arrive together", async () => {
    const t = await setup();
    const answers = await Promise.all(Array.from({ length: 5 }, () => t.prod.rubric("intent")));
    expect(answers.every((a) => a.versionId === t.a.id)).toBe(true);
    expect(t.requests).toHaveLength(1);
  });

  it("carries on with the version it holds when the server fails, is slow or refuses, and says so", async () => {
    const t = await setup({ timeoutMs: 20 });
    await t.prod.rubric("intent");
    for (const [down, message] of [["error", "connection refused"], ["hang", "no answer from https://verdict.example within 20 ms"], ["refuse", "this key may not read prod"]] as const) {
      t.state.down = down;
      t.state.clock += 60_000;
      expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.a.id, source: "stale" });
      expect((t.errors.at(-1) as Error).message).toContain(message);
    }
    // A failed check is not repeated on every call: the next one waits for the interval.
    const asked = t.requests.length;
    await t.prod.rubric("intent");
    expect(t.requests).toHaveLength(asked);
    t.state.down = false;
    t.state.clock += 60_000;
    expect((await t.prod.rubric("intent")).source).toBe("server");
    expect(await t.prod.refresh()).toBe(true);
  });

  it("refuses an answer whose rubric is not the version it names, keeping what it held", async () => {
    const t = await setup();
    await t.prod.rubric("intent");
    t.state.pointers = [{ name: "intent", versionId: t.b.id, rubric: { ...t.b.rubric, name: "Tampered" } }];
    t.state.clock = 60_000;
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.a.id, source: "stale" });
    expect(t.errors[0]).toMatchObject({ type: "integrity" });
  });

  it("throws at a cold start with no fallback, and asks again on the next call", async () => {
    const t = await setup();
    t.state.down = "error";
    await expect(t.prod.rubric("intent")).rejects.toMatchObject({ type: "environment_unavailable", message: expect.stringContaining("could not read prod in support bot and no fallback rubric was given for intent: Verdict request failed: connection refused") });
    await expect(t.prod.rubric("intent")).rejects.toBeInstanceOf(VerdictError);
    expect(t.requests).toHaveLength(2);
    expect(await t.prod.refresh()).toBe(false);
    t.state.down = false;
    expect((await t.prod.rubric("intent")).source).toBe("server");
  });

  it("runs the fallback while the server has given nothing, then the server's version for good", async () => {
    const t = await setup({ fallback: true });
    t.state.down = "error";
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.spare, source: "fallback", rubric: { criteria: [{ name: "Spare?" }] } });
    // On the fallback, a down server is asked once per interval, not once per call.
    await t.prod.rubric("intent");
    expect(t.requests).toHaveLength(1);
    t.state.down = false;
    t.state.clock = 60_000;
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.a.id, source: "server" });
    t.state.down = "error";
    t.state.clock = 120_000;
    expect(await t.prod.rubric("intent")).toMatchObject({ versionId: t.a.id, source: "stale" });
  });

  it("uses the fallback for a rubric the environment does not run yet, and says which rubric is missing otherwise", async () => {
    const t = await setup({ fallback: true });
    t.state.pointers = [];
    expect((await t.prod.rubric("intent")).source).toBe("fallback");
    await expect(t.prod.rubric("urgency")).rejects.toMatchObject({ status: 404, type: "not_promoted", message: "prod in support bot does not run urgency, and no fallback rubric was given for it" });
  });
});
