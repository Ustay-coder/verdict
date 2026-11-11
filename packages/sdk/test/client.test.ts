import { expect, it, vi } from "vitest";
import { Verdict, VerdictError } from "../src/index.js";

it("maps every client method to its REST request with an injected fetch", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, init: init! });
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "e", data: [], ranking: [], evaluations: [] });
  });
  const client = new Verdict({ baseUrl: "https://example.com/", apiKey: "secret", fetch });
  const rubric = { name: "Example", criteria: [{ id: "a", name: "A" }] };
  const checks: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => client.rubrics.create(rubric), "POST", "/v1/rubrics", rubric],
    [() => client.rubrics.create("name: Example"), "POST", "/v1/rubrics", "name: Example"],
    [() => client.rubrics.validate(rubric), "POST", "/v1/rubrics/validate", rubric],
    [() => client.rubrics.validate("name: Example"), "POST", "/v1/rubrics/validate", "name: Example"],
    [() => client.rubrics.get("r"), "GET", "/v1/rubrics/r"],
    [() => client.rubrics.list(), "GET", "/v1/rubrics"],
    [() => client.rubrics.update("r", rubric), "PUT", "/v1/rubrics/r", rubric],
    [() => client.rubrics.delete("r"), "DELETE", "/v1/rubrics/r"],
    [() => client.rubrics.calibration("r /", { target: 0.9, buckets: 10, limit: undefined }), "GET", "/v1/rubrics/r%20%2F/calibration?target=0.9&buckets=10"],
    [() => client.rubrics.calibration("r"), "GET", "/v1/rubrics/r/calibration?"],
    [() => client.publications.preview({ slug: "s", version: { id: "rv_x", rubric }, license: "CC0-1.0" }), "POST", "/v1/publications/preview", { slug: "s", version: { id: "rv_x", rubric }, license: "CC0-1.0" }],
    [() => client.publications.create({ slug: "s", version: { id: "rv_x", rubric }, license: "CC0-1.0" }), "POST", "/v1/publications", { slug: "s", version: { id: "rv_x", rubric }, license: "CC0-1.0" }],
    [() => client.publications.list(), "GET", "/v1/publications"],
    [() => client.hub.config(), "GET", "/v1/hub/config"],
    [() => client.hub.login("gho_x"), "POST", "/v1/hub/login", { githubToken: "gho_x" }],
    [() => client.hub.me(), "GET", "/v1/hub/me"],
    [() => client.hub.revokeKey("key /1"), "DELETE", "/v1/hub/keys/key%20%2F1"],
    [() => client.hub.search({ q: "상담원", type: "noul", limit: 5 }), "GET", "/v1/public/rubrics?q=%EC%83%81%EB%8B%B4%EC%9B%90&type=noul&limit=5"],
    [() => client.hub.card("alice", "agent-intent", { version: "rv_1" }), "GET", "/v1/public/rubrics/alice/agent-intent?version=rv_1"],
    [() => client.hub.publication("pub_1"), "GET", "/v1/public/publications/pub_1"],
    [() => client.publications.list({ limit: 5 }), "GET", "/v1/publications?limit=5"],
    [() => client.publications.withdraw("pub /1"), "DELETE", "/v1/publications/pub%20%2F1"],
    [() => client.evaluations.retry("e /"), "POST", "/v1/evaluations/e%20%2F/retry"],
    [() => client.evaluations.create({ rubric: "r" }), "POST", "/v1/evaluations", { rubric: "r" }],
    [() => client.evaluations.createAsync({ rubric: "r" }), "POST", "/v1/evaluations", { rubric: "r", async: true }],
    [() => client.evaluations.get("e"), "GET", "/v1/evaluations/e"],
    [() => client.evaluations.get("e", { evidence: true }), "GET", "/v1/evaluations/e?evidence=true"],
    [() => client.evaluations.list(), "GET", "/v1/evaluations?"],
    [() => client.evaluations.list({ rubric: "r", status: "completed", limit: 2 }), "GET", "/v1/evaluations?rubric=r&status=completed&limit=2"],
    [() => client.evaluations.submitScore("e", { criterionId: "a", raterId: "bob", score: "pass" }), "POST", "/v1/evaluations/e/scores", { criterionId: "a", raterId: "bob", score: "pass" }],
    [() => client.evaluations.reaggregate("e", { method: "min" }), "POST", "/v1/evaluations/e/aggregate", { aggregation: { method: "min" }, persist: false }],
    [() => client.tasks.list(), "GET", "/v1/tasks"],
    [() => client.tasks.list("bob /"), "GET", "/v1/tasks?rater=bob%20%2F"],
    [() => client.batches.create({ rubric: "r", subjects: [] }), "POST", "/v1/batches", { rubric: "r", subjects: [] }],
    [() => client.projects.create("bot"), "POST", "/v1/projects", { name: "bot" }],
    [() => client.projects.list(), "GET", "/v1/projects"],
    [() => client.projects.delete("bot"), "DELETE", "/v1/projects/bot", { confirm: "bot" }],
    [() => client.projects.history("bot", { environment: "prod", limit: 5 }), "GET", "/v1/projects/bot/history?environment=prod&limit=5"],
    [() => client.projects.history("bot"), "GET", "/v1/projects/bot/history"],
    [() => client.environments.create("bot", "prod"), "POST", "/v1/projects/bot/environments", { name: "prod" }],
    [() => client.environments.list("bot"), "GET", "/v1/projects/bot/environments"],
    [() => client.environments.get("bot", "prod"), "GET", "/v1/projects/bot/environments/prod"],
    [() => client.environments.delete("bot", "prod"), "DELETE", "/v1/projects/bot/environments/prod", { confirm: "prod" }],
    [() => client.environments.promote("bot", "prod", { changes: [{ name: "intent", versionId: "rv_b", expected: "rv_a" }], note: "n" }), "POST", "/v1/projects/bot/environments/prod/promotions", { changes: [{ name: "intent", versionId: "rv_b", expected: "rv_a" }], note: "n" }],
    [() => client.environments.rollback("bot", "prod", { name: "intent", expected: "rv_b" }), "POST", "/v1/projects/bot/environments/prod/rollbacks", { name: "intent", expected: "rv_b" }],
    [() => client.versions.names("bot"), "GET", "/v1/projects/bot/rubrics"],
    [() => client.versions.push("bot", "intent", { id: "rv_a", rubric }), "POST", "/v1/projects/bot/rubrics/intent/versions", { id: "rv_a", rubric }],
    [() => client.versions.list("bot", "intent", { limit: 3 }), "GET", "/v1/projects/bot/rubrics/intent/versions?limit=3"],
    [() => client.versions.get("bot", "intent", "rv_a"), "GET", "/v1/projects/bot/rubrics/intent/versions/rv_a"],
    [() => client.reports.run("bot", { name: "intent" } as never), "POST", "/v1/projects/bot/reports/runs", { name: "intent" }],
    [() => client.reports.runs("bot", { name: "intent", dataset: "cases.jsonl", limit: 2 }), "GET", "/v1/projects/bot/reports/runs?name=intent&dataset=cases.jsonl&limit=2"],
    [() => client.reports.getRun("bot", "run_1"), "GET", "/v1/projects/bot/reports/runs/run_1"],
    [() => client.reports.comparison("bot", { name: "intent" } as never), "POST", "/v1/projects/bot/reports/comparisons", { name: "intent" }],
    [() => client.reports.comparisons("bot", { head: "rv_b" }), "GET", "/v1/projects/bot/reports/comparisons?head=rv_b"],
    [() => client.versions.delete("bot", "intent", "rv /a"), "DELETE", "/v1/projects/bot/rubrics/intent/versions/rv%20%2Fa"],
  ];
  for (const [call, method, path, body] of checks) {
    await call();
    const request = calls.at(-1)!;
    // URL normalizes an empty query string away.
    expect(request.path).toBe(path.replace(/\?$/, ""));
    expect(request.init.method).toBe(method);
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer secret");
    expect(request.init.body).toBe(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  }
});

it("names the organisation on every request when one is given, and never otherwise", async () => {
  const seen: Array<string | null> = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("x-verdict-org")); return Response.json({ data: [], pointers: [] }); });
  const acme = new Verdict({ baseUrl: "https://example.com", fetch, org: "acme" });
  await acme.projects.list();
  await acme.environment({ project: "bot", environment: "prod" }).refresh();
  await new Verdict({ baseUrl: "https://example.com", fetch }).projects.list();
  expect(seen).toEqual(["acme", "acme", null]);
});

it.each(["completed", "failed", "pending_human"])("wait returns a settled %s evaluation", async status => {
  const client = new Verdict({ fetch: async () => Response.json({ status }) });
  expect((await client.evaluations.wait("e")).status).toBe(status);
});

it("polls queued/running and optionally waits for humans", async () => {
  const states = ["queued", "running", "pending_human", "completed"];
  const fetch = vi.fn(async () => Response.json({ status: states.shift() }));
  const client = new Verdict({ fetch });
  expect((await client.evaluations.wait("e", { intervalMs: 0, waitForHumans: true })).status).toBe("completed");
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("reports polling timeouts and HTTP errors including malformed response bodies", async () => {
  const pending = new Verdict({ fetch: async () => Response.json({ status: "running" }) });
  await expect(pending.evaluations.wait("e", { timeoutMs: -1 })).rejects.toMatchObject({ status: 408, type: "timeout" });
  const invalid = new Verdict({ fetch: async () => new Response("invalid", { status: 502 }) });
  await expect(invalid.rubrics.list()).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  const validation = new Verdict({ fetch: async () => Response.json({ error: { type: "validation", message: "bad", issues: ["x"] } }, { status: 422 }) });
  await expect(validation.evaluations.get("e")).rejects.toBeInstanceOf(VerdictError);
  const conflict = new Verdict({ fetch: async () => Response.json({ error: { type: "pointer_conflict", message: "changed", current: [{ name: "intent", versionId: "rv_b" }] } }, { status: 409 }) });
  await expect(conflict.environments.promote("bot", "prod", { changes: [{ name: "intent", versionId: "rv_c", expected: "rv_a" }] })).rejects.toMatchObject({ status: 409, type: "pointer_conflict", details: { current: [{ name: "intent", versionId: "rv_b" }] } });
  const failed = new Verdict({ fetch: async () => Response.json({ status: "failed" }, { status: 422 }) });
  expect((await failed.evaluations.get("e")).status).toBe("failed");
});

it("wraps network failures in VerdictError without losing the transport message", async () => {
  const client = new Verdict({ fetch: async () => { throw new TypeError("fetch failed: offline"); } });
  await expect(client.rubrics.list()).rejects.toBeInstanceOf(VerdictError);
  await expect(client.rubrics.list()).rejects.toMatchObject({ status: 0, type: "network", message: expect.stringContaining("offline") });
});

it("reports malformed successful JSON as a response error with its HTTP status", async () => {
  const client = new Verdict({ fetch: async () => new Response("broken", { status: 200 }) });
  await expect(client.rubrics.list()).rejects.toMatchObject({ status: 200, type: "invalid_response", message: "Verdict returned invalid JSON" });
});
