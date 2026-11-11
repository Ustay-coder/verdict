import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolve } from "node:path";
import { Engine, MemoryStore, getDecisionProvider, registerDecisionProvider } from "@verdict-ai/core";
import { createApp } from "@verdict-ai/api";
import { registerDiff } from "../src/commands/diff.js";
import { registerReport } from "../src/commands/report.js";
import { registerRun } from "../src/commands/run.js";
import { reportSource } from "../src/control/report.js";
import { slug } from "../src/control/names.js";
import type { HubDependencies } from "../src/hub/deps.js";

const SERVER = "https://verdict.example";
const SCOPE = { tenantId: "acme", project: "bot" };
const PRIVATE = ["kim-private", "Kim Minsu", "010-1234-5678", "eval_"];

const rubric = (keywords: string, extra = "") => `name: Wants an agent
${extra}criteria:
  - id: wants
    name: Wants an agent
    scale: { type: binary, labels: [no, yes] }
    judge: { type: benchmark, method: keywords, keywords: [${keywords}] }
`;
const cases = [
  { id: "explicit", name: "explicit", inputs: [{ type: "text", text: "connect me to an agent" }], expected: { wants: "yes" } },
  { id: "kim-private", name: "Kim Minsu", inputs: [{ type: "text", text: "Kim Minsu 010-1234-5678 wants a human" }], expected: { wants: "yes" } },
  { id: "faq", name: "faq", inputs: [{ type: "text", text: "what are your opening hours" }], expected: { wants: "no" } },
].map((c) => JSON.stringify(c)).join("\n");

async function setup(env: Record<string, string> = {}) {
  const remote = new MemoryStore();
  await remote.control.createProject({ tenantId: "acme", name: "bot", createdAt: "2026-11-01T00:00:00.000Z" });
  const server = createApp({ engine: new Engine({ store: remote }), auth: { resolve: (k) => (k === "sk_ci" ? "acme" : undefined) } });
  const sent: Array<{ method: string; path: string; body: string }> = [];
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(SERVER)) throw new Error(`unexpected ${url}`);
    sent.push({ method: init?.method ?? "GET", path: url.slice(SERVER.length), body: typeof init?.body === "string" ? init.body : "" });
    return server.request(url.slice(SERVER.length), init);
  }) as typeof fetch;
  const files = new Map<string, string>([[resolve("intent.yaml"), rubric("agent, human")], [resolve("base.yaml"), rubric("agent")], [resolve("cases.jsonl"), cases]]);
  const local = new Engine();
  const out = vi.fn(), warn = vi.fn(), exitCode = vi.fn();
  const deps: HubDependencies = {
    engine: () => local, remote: () => undefined, out, fail: vi.fn(), warn, exitCode,
    readText: async (p) => { const t = files.get(resolve(p)); if (t === undefined) throw new Error(`missing ${p}`); return t; },
    readBytes: async (p) => new TextEncoder().encode(files.get(resolve(p)) ?? ""),
    lockIo: { read: async (p) => files.get(resolve(p)), write: async (p, t) => { files.set(resolve(p), t); } },
    writeNew: async (p, t) => { files.set(resolve(p), t); },
    credentials: { read: async () => undefined, write: async () => undefined, remove: async () => undefined },
    env: { VERDICT_HUB_URL: SERVER, VERDICT_HUB_KEY: "sk_ci", VERDICT_PROJECT: "bot", VERDICT_API_KEY: "evaluation-server-key", ...env }, fetch: net, sleep: async () => undefined,
    confirm: async () => true, interactive: () => false,
  };
  const program = new Command();
  registerRun(program, deps); registerDiff(program, deps); registerReport(program, deps);
  const run = async (...args: string[]) => { out.mockClear(); warn.mockClear(); await program.parseAsync(args, { from: "user" }); return { out: out.mock.calls.map((c) => String(c[0])), warn: warn.mock.calls.map((c) => String(c[0])) }; };
  return { run, files, sent, remote: remote.control, local, exitCode };
}

describe("reporting runs to a project", () => {
  it("run --report sends the run's numbers and its version, and nothing about the cases", async () => {
    const t = await setup({ GITHUB_SHA: "abc123", GITHUB_REF_NAME: "main", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/bot", GITHUB_RUN_ID: "7" });
    const { out, warn } = await t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report", "--json");
    const { run } = JSON.parse(out[0]!) as { run: { id: string; rubricVersionId: string } };
    expect(warn).toEqual([`reported ${run.id} (intent at ${run.rubricVersionId}) to bot on ${SERVER}`]);
    expect(t.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/projects/bot/reports/runs"]);
    for (const leak of PRIVATE) expect(t.sent[0]!.body).not.toContain(leak);
    expect(t.sent[0]!.body).not.toContain("evaluation-server-key");
    const [stored] = await t.remote.listRunReports(SCOPE);
    expect(stored).toMatchObject({
      name: "intent", datasetName: "cases.jsonl", source: { commit: "abc123", branch: "main", url: "https://github.com/acme/bot/actions/runs/7" },
      summary: { runId: run.id, rubricVersionId: run.rubricVersionId, counts: { cases: 3 }, agreement: { criteria: { wants: { n: 3, agreed: 3 } } } },
    });
    expect(await t.remote.getVersion(SCOPE, "intent", run.rubricVersionId)).toBeTruthy();

    // The stored run can be reported again later: the server answers with what it has. A bare run id has no file to
    // take a name from, so without a lock entry or a rubric id the name has to be given.
    await expect(t.run("report", run.id)).rejects.toThrow("pass --name");
    expect((await t.run("report", run.id, "--name", "intent")).out).toEqual([`already reported: ${run.id} (intent at ${run.rubricVersionId}) in bot on ${SERVER}`]);
    t.files.set(resolve("verdict.lock"), `lockVersion: 1\nrubrics:\n  intent.yaml: { version: ${run.rubricVersionId} }\n`);
    expect((await t.run("report", run.id)).out[0]).toContain("(intent at ");
  });

  it("diff --report reports a policy change read from the base run's recorded answers", async () => {
    // Reports refuse mock providers, so the judge here is a real provider's name answering as the mock does.
    const mock = getDecisionProvider("mock");
    registerDecisionProvider({ name: "openrouter", acceptsImages: false, decide: (request, context) => mock.decide(request, context) });
    const t = await setup();
    const agent = (threshold: number) => `name: Wants an agent\ndefaultJudge: { type: decision, provider: openrouter, options: { noul: 0.7 } }\ncriteria:\n  - { id: wants, name: Wants an agent, scale: { type: binary, labels: [no, yes] }, threshold: ${threshold} }\n`;
    t.files.set(resolve("loose.yaml"), agent(0.6)).set(resolve("strict.yaml"), agent(0.75));
    const { warn } = await t.run("diff", "--base", "loose.yaml", "--head", "strict.yaml", "-d", "cases.jsonl", "--report");
    expect(warn).toContainEqual(expect.stringMatching(/only in policy: re-scored run_\w+'s recorded answers \(no judge calls\)/));
    expect(warn).toContainEqual(expect.stringMatching(/^reported comparison cmp_\w+ \(policy_change\) to bot on /));
    expect(await t.remote.listRunReports(SCOPE)).toHaveLength(2);
    expect(await t.remote.listComparisonReports(SCOPE)).toMatchObject([{ kind: "policy_change", conditions: { diffs: [{ field: "policyHash" }] }, criteria: [{ criterionId: "wants", counts: { cases: 3 } }] }]);
    for (const request of t.sent) for (const leak of PRIVATE) expect(request.body).not.toContain(leak);
  });

  it("diff --report sends both runs and the comparison's counts, then applies the gate", async () => {
    const t = await setup();
    const { warn } = await t.run("diff", "--base", "base.yaml", "--head", "intent.yaml", "-d", "cases.jsonl", "--report", "--markdown", "--fail-on", "fixed");
    expect(warn.filter((l) => l.startsWith("reported"))).toEqual([
      expect.stringMatching(/^reported run_\w+ \(intent at rv_\w+\) to bot on /), expect.stringMatching(/^reported run_\w+ \(intent at rv_\w+\) to bot on /),
      expect.stringMatching(/^reported comparison cmp_\w+ \(rubric_change\) to bot on /),
    ]);
    expect(warn.at(-1)).toBe("diff: 1 fixed (--fail-on fixed)");
    expect(t.exitCode).toHaveBeenCalledWith(1);
    expect(t.sent.map((r) => r.path)).toEqual(["/v1/projects/bot/reports/runs", "/v1/projects/bot/reports/runs", "/v1/projects/bot/reports/comparisons"]);
    for (const request of t.sent) for (const leak of PRIVATE) expect(request.body).not.toContain(leak);
    expect(await t.remote.listRunReports(SCOPE, { name: "intent" })).toHaveLength(2);
    const [comparison] = await t.remote.listComparisonReports(SCOPE);
    expect(comparison).toMatchObject({ name: "intent", kind: "rubric_change", criteria: [{ criterionId: "wants", counts: { fixed: 1, kept_match: 2, cases: 3 } }] });
    expect(JSON.stringify(comparison)).not.toContain("caseId");
    // Both versions are kept under the head file's name, so either can be promoted.
    expect((await t.remote.listRubricNames(SCOPE))).toEqual([{ name: "intent", versions: 2, updatedAt: expect.any(String) }]);
  });

  it("names the rubric from --name, the lock, its id, then its file", async () => {
    const t = await setup();
    const name = async (...args: string[]) => /\((\S+) at /.exec((await t.run("run", "-d", "cases.jsonl", "--report", ...args)).warn.at(-1)!)![1];
    expect(await name("-r", "intent.yaml")).toBe("intent");
    t.files.set(resolve("Support Intent.v2.yaml"), rubric("agent, please"));
    expect(await name("-r", "Support Intent.v2.yaml")).toBe("support-intent-v2");
    t.files.set(resolve("with-id.yaml"), rubric("agent, operator", "id: Agent_Intent\n"));
    expect(await name("-r", "with-id.yaml")).toBe("agent-intent");
    t.files.set(resolve("verdict.lock"), "lockVersion: 1\nrubrics:\n  with-id.yaml: { name: routing }\n");
    expect(await name("-r", "with-id.yaml")).toBe("routing");
    expect(await name("-r", "with-id.yaml", "--name", "override")).toBe("override");
    await expect(t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report", "--name", "Not A Slug")).rejects.toThrow("--name");
    expect(slug("---")).toBe("");
  });

  it("refuses before any case runs when there is nowhere to report, or the run would be a mock run", async () => {
    const t = await setup();
    const evaluations = async () => (await t.local.store.listEvaluations({ limit: 100 })).length;
    await expect(t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report", "--mock")).rejects.toThrow("--mock runs are not reported");
    await expect(t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report", "--project", "No Such")).rejects.toThrow("project name");
    const none = await setup({ VERDICT_PROJECT: "" });
    await expect(none.run("diff", "--base", "base.yaml", "--head", "intent.yaml", "-d", "cases.jsonl", "--report")).rejects.toThrow("no project");
    expect(await evaluations()).toBe(0);
    expect(t.sent).toEqual([]);
    // A stored run made with mock providers is refused too.
    t.files.set(resolve("mock.yaml"), "name: Mocked\ndefaultJudge: { type: decision, provider: mock }\ncriteria:\n  - { id: wants, name: Wants an agent, scale: { type: binary, labels: [no, yes] }, threshold: 0.5 }\n");
    const { out } = await t.run("run", "-r", "mock.yaml", "-d", "cases.jsonl", "--json");
    await expect(t.run("report", (JSON.parse(out[0]!) as { run: { id: string } }).run.id)).rejects.toThrow("used mock providers");
    expect(t.sent).toEqual([]);
  });

  it("says how to sign in when the server rejects the key, and passes the server's own refusals through", async () => {
    const wrong = await setup({ VERDICT_HUB_KEY: "sk_wrong" });
    await expect(wrong.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report")).rejects.toThrow(`${SERVER} did not accept the key: run \`verdict login --hub ${SERVER}\``);
    const t = await setup();
    await expect(t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report", "--project", "elsewhere")).rejects.toThrow("project elsewhere not found");
  });

  it("reads where a run came from from flags first, then GitHub Actions", () => {
    expect(reportSource({}, {})).toEqual({});
    expect(reportSource({ GITHUB_SHA: "s", GITHUB_HEAD_REF: "feature/x", GITHUB_REF_NAME: "7/merge" }, {})).toEqual({ commit: "s", branch: "feature/x" });
    expect(reportSource({ GITHUB_SHA: "s", GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "main" }, { commit: "c", runUrl: "https://ci/1" })).toEqual({ commit: "c", branch: "main", url: "https://ci/1" });
  });
});
