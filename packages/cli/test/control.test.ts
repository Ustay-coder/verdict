import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { join, resolve } from "node:path";
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp } from "@verdict-ai/api";
import { registerCheck } from "../src/commands/check.js";
import { registerDiff } from "../src/commands/diff.js";
import { registerEvaluate } from "../src/commands/evaluate.js";
import { registerHub } from "../src/commands/hub.js";
import { registerEnv, registerProject } from "../src/commands/project.js";
import { registerPromote } from "../src/commands/promote.js";
import { registerPull } from "../src/commands/pull.js";
import { registerRun } from "../src/commands/run.js";
import { registerVersion } from "../src/commands/version.js";
import type { HubCredentials } from "../src/hub/credentials.js";
import type { HubDependencies } from "../src/hub/deps.js";
import { parseInput } from "../src/inputs.js";
import { loadCommandRubric } from "../src/remote.js";

const SERVER = "https://verdict.example";
const SCOPE = { tenantId: "acme", project: "bot" };

const rubric = (keywords: string) => `name: Wants an agent
criteria:
  - id: wants
    name: Wants an agent
    scale: { type: binary, labels: [no, yes] }
    judge: { type: benchmark, method: keywords, keywords: [${keywords}] }
`;
const cases = [{ id: "explicit", name: "explicit", inputs: [{ type: "text", text: "connect me to an agent" }], expected: { wants: "yes" } }].map((c) => JSON.stringify(c)).join("\n");

interface Options {
  env?: Record<string, string>; interactive?: boolean; confirm?: () => Promise<boolean> | boolean; cwd?: string; secret?: string; remote?: boolean;
  /** What the server announces as its own sign-in, and the routes that serve it (a server built on top of this one). */
  signIn?: { kind: "browser"; start: string; token: string };
  routes?: (path: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined;
}

function setup(o: Options = {}) {
  const remote = new MemoryStore();
  const server = createApp({ engine: new Engine({ store: remote }), ...(o.signIn ? { signIn: o.signIn } : {}), auth: { resolve: (k) => (k === "sk_team" ? { tenantId: "acme", actor: { kind: "key", id: "key_1", name: "laptop" } } : k === "sk_other" ? "other" : undefined) } });
  const sent: Array<{ method: string; path: string; key: string | null; org: string | null }> = [];
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ method: init?.method ?? "GET", path: url.pathname, key: new Headers(init?.headers).get("authorization"), org: new Headers(init?.headers).get("x-verdict-org") });
    const own = await o.routes?.(url.pathname, init);
    return own ?? server.request(url.pathname + url.search, init);
  }) as typeof fetch;
  /** One computer: its own files, data directory and saved sign-ins. Every machine talks to the same server. */
  const machine = (own: Array<[string, string]> = [["intent.yaml", rubric("agent")], ["cases.jsonl", cases]]) => {
    const files = new Map<string, string>(own.map(([path, text]) => [resolve(path), text]));
    const saved = new Map<string, HubCredentials>();
    let latest: string | undefined;
    const local = new Engine();
    const out = vi.fn(), warn = vi.fn();
    const readText = async (p: string) => { const t = files.get(resolve(p)); if (t === undefined) throw new Error(`missing ${p}`); return t; };
    const deps: HubDependencies = {
      engine: () => local, remote: () => (o.remote ? {} as never : undefined), out, fail: vi.fn(), warn, exitCode: vi.fn(),
      readText,
      readBytes: async (p) => new TextEncoder().encode(files.get(resolve(p)) ?? ""),
      lockIo: { read: async (p) => files.get(resolve(p)), write: async (p, t) => { files.set(resolve(p), t); } },
      writeNew: async (p, t, overwrite) => { if (!overwrite && files.has(resolve(p))) throw new Error(`${p} exists; pass --force to replace it`); files.set(resolve(p), t); },
      credentials: {
        read: async (hub) => saved.get(hub ?? latest ?? ""),
        write: async (c) => { saved.set(c.hub, c); latest = c.hub; },
        remove: async (hub) => { saved.delete(hub ?? latest ?? ""); },
      },
      env: { VERDICT_HUB_URL: SERVER, VERDICT_HUB_KEY: "sk_team", VERDICT_PROJECT: "bot", ...o.env }, fetch: net, sleep: async () => undefined,
      confirm: async () => (o.confirm ? o.confirm() : true), interactive: () => o.interactive ?? false,
      readSecret: async () => o.secret ?? "", cwd: () => o.cwd ?? resolve("."),
    };
    const program = new Command();
    registerHub(program, deps); registerProject(program, deps); registerEnv(program, deps); registerPromote(program, deps); registerRun(program, deps); registerVersion(program, deps);
    registerDiff(program, deps); registerPull(program, deps);
    const loadRubric = (ref: string, mock?: boolean) => loadCommandRubric(ref, mock, readText);
    registerEvaluate(program, { loadRubric, parseInput, readStdin: async () => "", remote: () => undefined, localEngine: () => local, stdout: out, setExitCode: vi.fn(), server: deps });
    registerCheck(program, { engine: () => local, remote: () => undefined, out, fail: vi.fn(), loadRubric, readText, server: deps });
    const run = async (...args: string[]) => { out.mockClear(); warn.mockClear(); await program.parseAsync(args, { from: "user" }); return { out: out.mock.calls.map((c) => String(c[0])), warn: warn.mock.calls.map((c) => String(c[0])) }; };
    const lock = () => files.get(resolve("verdict.lock")) ?? "";
    return { run, files, saved, lock, warn, local };
  };
  return { ...machine(), sent, control: remote.control, machine };
}

/** A project with staging and prod, and intent.yaml frozen in the lock. */
async function ready(o: Options = {}) {
  const t = setup(o);
  await t.run("project", "create", "bot");
  await t.run("env", "create", "staging");
  await t.run("env", "create", "prod");
  await t.run("version", "freeze", "intent.yaml");
  const id = /version: (rv_\w+)/.exec(t.lock())![1]!;
  return { ...t, a: id };
}

const freezeNew = async (t: Awaited<ReturnType<typeof ready>>, keywords: string) => {
  t.files.set(resolve("intent.yaml"), rubric(keywords));
  await t.run("version", "freeze", "intent.yaml");
  return /version: (rv_\w+)/.exec(t.lock())![1]!;
};

describe("verdict project, env, push, promote, rollback", () => {
  it("uploads a version, promotes it through two environments, and rolls it back", async () => {
    const t = await ready();
    expect((await t.run("project", "list")).out).toEqual([expect.stringMatching(/^bot\t/)]);
    expect((await t.run("env", "list")).out.map((l) => l.split("\t")[0])).toEqual(["staging", "prod"]);
    expect((await t.run("env", "show", "prod")).out).toEqual(["prod runs nothing yet; `verdict promote <rubric file> --env prod` puts a version there"]);

    // The first upload settles the name services will ask for, and the lock keeps it.
    expect((await t.run("push", "intent.yaml")).out).toEqual([`pushed intent at ${t.a} to bot on ${SERVER}`]);
    expect(t.lock()).toMatch(/intent\.yaml:\n {4}name: intent\n {4}version: rv_/);
    expect((await t.run("push", "intent.yaml")).out).toEqual([`already there: intent at ${t.a} in bot on ${SERVER}`]);

    // Nobody reported a run of this version yet: promoting is allowed, and said out loud.
    const first = await t.run("promote", "intent.yaml", "--env", "staging", "--yes", "--note", "first release");
    expect(first.warn).toEqual([expect.stringContaining(`no run of intent at ${t.a} has been reported to bot`)]);
    expect(first.out).toEqual([`staging in bot on ${SERVER}:`, `  intent: (none) → ${t.a}`, `promoted intent to ${t.a} in staging`]);
    expect((await t.run("promote", "intent.yaml", "--env", "staging", "--yes")).out).toEqual([`intent is already at ${t.a} in staging`]);

    await t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl", "--report");
    const copied = await t.run("promote", "--from", "staging", "--env", "prod", "--yes");
    expect(copied.warn).toEqual([]);
    expect(copied.out.at(-1)).toBe(`promoted intent to ${t.a} in prod`);

    const b = await freezeNew(t, "agent, human");
    expect(t.lock()).toContain("name: intent");
    expect((await t.run("promote", "intent.yaml", "--env", "prod", "--yes")).out).toEqual([`prod in bot on ${SERVER}:`, `  intent: ${t.a} → ${b}`, `promoted intent to ${b} in prod`]);
    expect((await t.run("env", "show", "prod")).out).toEqual([expect.stringMatching(new RegExp(`^intent\\t${b}\\t`))]);

    const back = await t.run("rollback", "intent", "--env", "prod", "--yes", "--note", "wrong hand-offs");
    expect(back.out).toEqual([`prod in bot on ${SERVER}:`, expect.stringMatching(new RegExp(`^  intent: ${b} → ${t.a}  \\(undoes the promote of `)), `rolled back intent in prod: ${b} → ${t.a}`]);
    const history = (await t.run("env", "history", "--env", "prod")).out;
    expect(history.map((l) => l.split("\t").slice(1).join(" | "))).toEqual([
      `prod | intent | ${b} → ${t.a} | rollback by laptop | “wrong hand-offs”`, `prod | intent | ${t.a} → ${b} | promote by laptop`, `prod | intent | (none) → ${t.a} | promote by laptop`,
    ]);
    expect((await t.run("env", "history", "--name", "intent", "--limit", "1", "--json")).out.join("")).toContain('"kind": "rollback"');

    expect((await t.run("env", "unset", "intent", "--env", "staging", "--yes")).out.at(-1)).toBe(`staging no longer runs intent (was ${t.a})`);
    expect((await t.run("env", "unset", "intent", "--env", "staging", "--yes")).out).toEqual(["intent has no pointer in staging"]);
    expect((await t.control.listPointers(SCOPE, "staging"))).toEqual([]);
  });

  it("promotes from a file only what verdict.lock says was frozen", async () => {
    const t = await ready();
    t.files.set(resolve("intent.yaml"), rubric("agent, operator"));
    await expect(t.run("promote", "intent.yaml", "--env", "prod", "--yes")).rejects.toThrow(/intent\.yaml freezes to rv_\w+, but verdict\.lock locks rv_\w+; run `verdict version freeze intent\.yaml`/);
    t.files.set(resolve("new.yaml"), rubric("human"));
    await expect(t.run("promote", "new.yaml", "--env", "prod", "--yes")).rejects.toThrow("verdict.lock does not list it");
    expect(t.sent.filter((r) => r.method === "POST" && r.path.includes("/promotions"))).toEqual([]);
    // Uploading a file freezes it: the lock then lists it under the name it was given, and it can be promoted.
    const pushed = await t.run("push", "new.yaml", "--name", "fallback");
    expect(pushed.out[0]).toMatch(/^pushed fallback at rv_/);
    expect(pushed.warn).toEqual([]);
    expect(t.lock()).toMatch(/new\.yaml:\n {4}name: fallback\n {4}version: rv_/);
    expect((await t.run("promote", "new.yaml", "--env", "prod", "--yes")).out.at(-1)).toMatch(/^promoted fallback to rv_\w+ in prod$/);
  });

  it("shows the change and asks first; without a terminal it needs --yes", async () => {
    const piped = await ready();
    await expect(piped.run("promote", "intent.yaml", "--env", "prod")).rejects.toThrow("pass --yes");
    expect(piped.out).toBeUndefined();
    const declined = await ready({ interactive: true, confirm: () => false });
    expect((await declined.run("promote", "intent.yaml", "--env", "prod")).out).toEqual([`prod in bot on ${SERVER}:`, `  intent: (none) → ${declined.a}`, "nothing changed"]);
    expect(await declined.control.listPointers(SCOPE, "prod")).toEqual([]);
    // Saying no uploads nothing either.
    expect(await declined.control.listVersions(SCOPE)).toEqual([]);
    expect((await declined.run("project", "delete", "bot")).out.at(-1)).toBe("nothing deleted");
    expect((await declined.run("env", "delete", "prod")).out.at(-1)).toBe("nothing deleted");
    expect((await piped.run("env", "delete", "staging", "--yes")).out.at(-1)).toBe("deleted environment staging");
    expect((await piped.run("project", "delete", "bot", "-y")).out.at(-1)).toBe("deleted project bot");
    expect(await piped.control.listProjects("acme")).toEqual([]);
  });

  it("applies nothing when someone else moved the pointer after it was shown", async () => {
    let t!: Awaited<ReturnType<typeof ready>>;
    let other = "";
    // While the question is on screen, someone else moves the pointer to the other of the two versions.
    let moves = 0;
    const interfere = async () => {
      const [now] = await t.control.listPointers(SCOPE, "prod");
      await t.control.applyPromotions([{ ...SCOPE, id: `prm_other_${moves++}`, environment: "prod", name: "intent", from: now!.versionId, to: now!.versionId === t.a ? other : t.a, kind: "promote", at: new Date().toISOString() }]);
      return true;
    };
    t = await ready({ interactive: true, confirm: interfere });
    await t.run("push", "intent.yaml");
    await t.control.applyPromotions([{ ...SCOPE, id: "prm_first", environment: "prod", name: "intent", from: null, to: t.a, kind: "promote", at: new Date().toISOString() }]);
    other = await freezeNew(t, "agent, human");
    await t.run("push", "intent.yaml");
    const mine = await freezeNew(t, "agent, operator");
    await expect(t.run("promote", "intent.yaml", "--env", "prod")).rejects.toThrow(`prod changed since it was read: intent is at ${other}. Nothing was applied; run the command again`);
    expect((await t.control.listPointers(SCOPE, "prod"))[0]!.versionId).toBe(other);
    expect(mine).not.toBe(other);
    await expect(t.run("rollback", "intent", "--env", "prod")).rejects.toThrow(`prod changed since it was read: intent is at ${t.a}`);
  });

  it("promotes versions by id, by name from another environment, and refuses what cannot be one change", async () => {
    const t = await ready();
    await t.run("promote", "intent.yaml", "--env", "staging", "--yes");
    // A version this machine holds is uploaded under the name the lock gives its file.
    expect((await t.run("promote", t.a, "--env", "prod", "--yes")).out.at(-1)).toBe(`promoted intent to ${t.a} in prod`);
    await expect(t.run("promote", "rv_00000000000000000000", "--env", "prod", "--yes")).rejects.toThrow("pass --name <name> to use the version the server keeps");
    await expect(t.run("promote", "rv_00000000000000000000", "--env", "prod", "--yes", "--name", "intent")).rejects.toThrow("is not kept under intent");
    await expect(t.run("promote", "intent.yaml", t.a, "--env", "prod", "--yes")).rejects.toThrow("intent is named twice");
    await expect(t.run("promote", "intent.yaml", t.a, "--env", "prod", "--name", "x")).rejects.toThrow("--name goes with exactly one");
    await expect(t.run("promote", "--env", "prod")).rejects.toThrow("name a rubric file or version");
    await expect(t.run("promote", "notes.txt", "--env", "prod")).rejects.toThrow("expected a rubric file");
    await expect(t.run("promote", "urgency", "--from", "staging", "--env", "prod", "--yes")).rejects.toThrow("staging does not run urgency");
    await expect(t.run("promote", "intent.yaml", "--from", "staging", "--env", "prod")).rejects.toThrow("name rubrics");
    expect((await t.run("promote", "intent", "--from", "staging", "--env", "prod", "--yes")).out).toEqual([`intent is already at ${t.a} in prod`]);
    await expect(t.run("promote", "intent.yaml", "--env", "nowhere", "--yes")).rejects.toThrow("environment nowhere not found");
    await expect(t.run("rollback", "intent", "--env", "prod", "--yes")).rejects.toThrow("no earlier version on record");
  });
});

describe("using a rubric the server keeps, from any machine", () => {
  /** One machine uploads and promotes; `other` is a second one that has the cases but no rubric file. */
  async function shared() {
    const t = await ready();
    await t.run("push", "intent.yaml");
    await t.run("promote", "intent.yaml", "--env", "prod", "--yes");
    return { ...t, other: t.machine([["cases.jsonl", cases]]) };
  }
  const asked = (t: { sent: unknown[] }) => t.sent.length;

  it("runs what an environment runs, the newest upload, or one version, without a rubric file", async () => {
    const t = await shared(), b = t.other;
    const viaEnv = await b.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl");
    expect(viaEnv.warn).toEqual([`intent: ${t.a}, what prod runs in bot on ${SERVER}`]);
    expect(viaEnv.out.join("\n")).toContain(t.a);
    // What it fetched is the same version, and it is kept here.
    expect((await b.local.store.getRubricVersion(t.a))?.id).toBe(t.a);
    expect(b.files.has(resolve("intent.yaml"))).toBe(false);

    // A newer version that nobody promoted yet is shared by uploading it; the other machine asks for the newest.
    const newer = await freezeNew(t, "agent, human");
    await t.run("push", "intent.yaml");
    expect((await b.run("run", "-r", "intent@latest", "-d", "cases.jsonl")).warn).toEqual([`intent: ${newer}, the newest version in bot on ${SERVER}`]);
    // prod still runs the first one.
    expect((await b.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl")).warn).toEqual([`intent: ${t.a}, what prod runs in bot on ${SERVER}`]);

    // A version never changes: one already on the machine is used without asking anybody.
    const before = asked(t);
    expect((await b.run("run", "-r", `intent@${newer}`, "-d", "cases.jsonl")).warn).toEqual([`intent: ${newer} (already on this machine)`]);
    expect(asked(t)).toBe(before);
    // On a machine that never saw it, it is fetched by id.
    const c = t.machine([["cases.jsonl", cases]]);
    expect((await c.run("run", "-r", `intent@${t.a}`, "-d", "cases.jsonl")).warn).toEqual([`intent: ${t.a} from bot on ${SERVER}`]);
  });

  it("reports such a run under the name it was asked for by", async () => {
    const t = await shared();
    const reported = await t.other.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl", "--report");
    expect(reported.warn.at(-1)).toMatch(new RegExp(`^reported run_\\w+ \\(intent at ${t.a}\\) to bot on `));
  });

  it("judges with it in the everyday commands too", async () => {
    const t = await shared(), b = t.other;
    const judged = await b.run("eval", "-r", "intent", "--env", "prod", "-i", "text:connect me to an agent", "--json");
    expect(judged.warn).toEqual([`intent: ${t.a}, what prod runs in bot on ${SERVER}`]);
    expect(JSON.parse(judged.out[0]!)).toMatchObject({ status: "completed", rubric: { name: "Wants an agent" } });
    b.files.set(resolve("gold.jsonl"), JSON.stringify({ name: "explicit", inputs: [{ type: "text", text: "connect me to an agent" }], expected: { wants: "yes" } }));
    const checked = await b.run("check", "-r", "intent@latest", "-g", "gold.jsonl");
    expect(checked.warn).toEqual([`intent: ${t.a}, the newest version in bot on ${SERVER}`]);
    // The gold set labels the one criterion, so the agreement is on that line.
    expect(checked.out.join("\n")).toMatch(/wants\s+1\/1 \(100%\)/);
  });

  it("compares a file being edited with what an environment runs", async () => {
    const t = await shared();
    t.files.set(resolve("intent.yaml"), rubric("agent, human"));
    const compared = await t.run("diff", "--base", "intent", "--env", "prod", "--head", "intent.yaml", "-d", "cases.jsonl", "--json");
    expect(compared.warn[0]).toBe(`intent: ${t.a}, what prod runs in bot on ${SERVER}`);
    expect(JSON.parse(compared.out[0]!)).toMatchObject({ base: { rubricVersionId: t.a } });
  });

  it("says what to do when the name cannot be resolved, and uses nothing the server misnamed", async () => {
    const t = await shared(), b = t.other;
    const run = (...ref: string[]) => b.run("run", "-r", ...ref, "-d", "cases.jsonl");
    await expect(run("intent")).rejects.toThrow("say which version: `intent --env <environment>` (what it runs), `intent@latest` (the newest uploaded) or `intent@rv_…`");
    await expect(run("intent@latest", "--env", "prod")).rejects.toThrow("name a version or an environment, not both");
    await expect(run("intent@yesterday")).rejects.toThrow("after @ comes `latest` or a version id");
    await expect(run("intent", "--env", "staging")).rejects.toThrow(`staging in bot on ${SERVER} does not run intent; nothing has been promoted to it yet`);
    await expect(run("urgency", "--env", "prod")).rejects.toThrow(`prod in bot on ${SERVER} does not run urgency; it runs intent`);
    await expect(run("intent", "--env", "nowhere")).rejects.toThrow(`bot on ${SERVER} has no environment nowhere`);
    await expect(run("urgency@latest")).rejects.toThrow(`bot on ${SERVER} keeps no version of urgency`);
    await expect(run("intent@rv_00000000000000000000")).rejects.toThrow(`keeps no version rv_00000000000000000000 of intent`);
    // `--env` does not change what a file means.
    expect((await t.run("run", "-r", "intent.yaml", "--env", "prod", "-d", "cases.jsonl")).warn).toEqual([]);

    // Asking what an environment runs needs the server; the message says what works without it.
    const offline = setup({ routes: () => { throw new TypeError("fetch failed"); } });
    await expect(offline.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl")).rejects.toThrow(`cannot reach ${SERVER} to ask which version of intent that is; a version this machine already holds runs without the server`);

    // A server that names one version and sends another document is not believed.
    const lying = setup({ routes: (path) => (path.endsWith("/environments/prod") ? Response.json({ name: "prod", createdAt: "2026-01-01T00:00:00.000Z", pointers: [{ name: "intent", versionId: t.a, updatedAt: "2026-01-01T00:00:00.000Z", rubric: { name: "Something else", criteria: [{ id: "x", name: "X", scale: { type: "binary" }, judge: { type: "benchmark", method: "keywords", keywords: ["x"] } }] } }] }) : undefined) });
    await expect(lying.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl")).rejects.toThrow(new RegExp(`named ${t.a} for intent, but the rubric it sent freezes to rv_\\w+; nothing was used`));
    expect(await lying.local.store.getRubricVersion(t.a)).toBeUndefined();
  });

  it("pulls a version into a file, and uploading an edited copy takes one command", async () => {
    const t = await shared(), b = t.other;
    expect((await b.run("pull", "intent", "--env", "prod")).out).toEqual([`wrote intent.yaml (intent: ${t.a}, what prod runs in bot on ${SERVER})`]);
    // The file is the same version, and the lock knows its name on the server.
    expect(b.lock()).toMatch(new RegExp(`intent\\.yaml:\\n {4}name: intent\\n {4}version: ${t.a}\\n`));
    expect((await b.run("version", "verify")).out.join("\n")).toContain(t.a);
    await expect(b.run("pull", "intent@latest")).rejects.toThrow("intent.yaml exists; pass --force to replace it");
    expect((await b.run("pull", "intent@latest", "--to", "copy.yaml")).out[0]).toMatch(/^wrote copy\.yaml /);
    await expect(b.run("pull", "intent")).rejects.toThrow("expected a hub card (hub:owner/slug[@rv_…]) or a rubric on your team's server");

    // Edited there, uploaded with one command, and promoted: no separate freeze.
    b.files.set(resolve("intent.yaml"), rubric("agent, human"));
    const pushed = await b.run("push", "intent.yaml");
    const next = /pushed intent at (rv_\w+) to bot/.exec(pushed.out[0]!)![1]!;
    expect(next).not.toBe(t.a);
    expect(b.lock()).toContain(`version: ${next}`);
    expect((await b.run("promote", "intent.yaml", "--env", "prod", "--yes")).out.at(-1)).toBe(`promoted intent to ${next} in prod`);
    // And the first machine gets it by name.
    expect((await t.run("run", "-r", "intent", "--env", "prod", "-d", "cases.jsonl")).warn).toEqual([`intent: ${next}, what prod runs in bot on ${SERVER}`]);
  });
});

describe("where the commands look for the project, the server and the key", () => {
  it("reads verdict.yaml from the working directory upwards, after options and the environment", async () => {
    const nested = resolve("services/api");
    const t = setup({ env: { VERDICT_PROJECT: "", VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "sk_team" }, cwd: nested });
    await expect(t.run("env", "list")).rejects.toThrow("add `project: <name>` to verdict.yaml");
    t.files.set(resolve("verdict.yaml"), `project: bot\nserver: ${SERVER}/\n`);
    await t.run("project", "create", "bot");
    expect(t.sent.at(-1)).toMatchObject({ method: "POST", path: "/v1/projects", key: "Bearer sk_team" });
    await t.run("env", "create", "prod");
    expect(await t.control.listEnvironments(SCOPE)).toHaveLength(1);
    // The nearest file is the whole configuration; an option wins over any file.
    t.files.set(join(nested, "verdict.yaml"), "project: elsewhere\n");
    await expect(t.run("env", "list")).rejects.toThrow("no hub configured");
    t.files.set(join(nested, "verdict.yaml"), `project: elsewhere\nserver: ${SERVER}\n`);
    await expect(t.run("env", "list")).rejects.toThrow("project elsewhere not found");
    expect((await t.run("env", "list", "--project", "bot")).out).toHaveLength(1);
    t.files.set(join(nested, "verdict.yaml"), "project: bot\nserver: verdict.example\n");
    await expect(t.run("env", "list")).rejects.toThrow("server must be an http(s) URL");
    t.files.set(join(nested, "verdict.yaml"), "project: Not A Slug\n");
    await expect(t.run("env", "list")).rejects.toThrow("verdict.yaml: project must be");
    t.files.set(join(nested, "verdict.yaml"), "- a list\n");
    await expect(t.run("env", "list")).rejects.toThrow("expected `project: <name>`");
  });

  it("keeps one key per server and uses each only for its own server", async () => {
    const t = setup({ env: { VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "" }, secret: "sk_team" });
    expect((await t.run("login", "--hub", SERVER, "--with-key")).out).toEqual([`saved the key for ${SERVER}`]);
    expect((await t.run("project", "create", "bot")).out).toEqual([`created project bot on ${SERVER}`]);
    // Another server, another key: signing in there does not replace the first.
    const second = "https://other.example";
    expect((await t.run("hub", "login", "--hub", second, "--with-key")).out).toEqual([`saved the key for ${second}`]);
    expect([...t.saved.keys()]).toEqual([SERVER, second]);
    await t.run("project", "list", "--hub", SERVER);
    expect(t.sent.at(-1)!.key).toBe("Bearer sk_team");
    expect((await t.run("hub", "logout", "--hub", SERVER)).out).toEqual([`signed out of ${SERVER}`]);
    expect([...t.saved.keys()]).toEqual([second]);
    expect((await t.run("hub", "logout", "--hub", SERVER)).out).toEqual([`not signed in to ${SERVER}`]);

    const wrong = setup({ env: { VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "" }, secret: "sk_typo" });
    await expect(wrong.run("login", "--hub", SERVER, "--with-key")).rejects.toThrow("did not accept that key; nothing was saved");
    expect(wrong.saved.size).toBe(0);
    const none = setup({ env: { VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "" } });
    await expect(none.run("login", "--hub", SERVER, "--with-key")).rejects.toThrow("no key given");
    await expect(none.run("login", "--hub", SERVER)).rejects.toThrow(`save a key from its operator with \`verdict login --hub ${SERVER} --with-key\``);
    await expect(none.run("project", "list", "--hub", SERVER)).rejects.toThrow(`${SERVER} did not accept the key: run \`verdict login --hub ${SERVER}\``);
  });

  it("works while VERDICT_API_URL points evaluation at a server: these commands only send versions", async () => {
    const t = await ready({ remote: true }).catch((e: Error) => e);
    // `version freeze` is a local-engine command; push and promote are not.
    expect(t).toBeInstanceOf(Error);
    const local = await ready();
    const remote = setup({ remote: true });
    for (const [path, text] of local.files) remote.files.set(path, text);
    await remote.run("project", "create", "bot");
    await remote.run("env", "create", "prod");
    expect((await remote.run("promote", "intent.yaml", "--env", "prod", "--yes")).out.at(-1)).toBe(`promoted intent to ${local.a} in prod`);
  });

  it("names the organization from the option, the environment, then verdict.yaml — and sends none otherwise", async () => {
    const t = setup();
    await t.run("project", "list");
    expect(t.sent.at(-1)!.org).toBeNull();
    t.files.set(resolve("verdict.yaml"), "project: bot\norg: acme\n");
    await t.run("project", "list");
    expect(t.sent.at(-1)!.org).toBe("acme");
    await t.run("project", "create", "bot");
    await t.run("env", "list");
    expect(t.sent.at(-1)!.org).toBe("acme");
    const viaEnv = setup({ env: { VERDICT_ORG: "from-env" } });
    viaEnv.files.set(resolve("verdict.yaml"), "project: bot\norg: acme\n");
    await viaEnv.run("project", "list");
    expect(viaEnv.sent.at(-1)!.org).toBe("from-env");
    await viaEnv.run("project", "list", "--org", "from-flag");
    expect(viaEnv.sent.at(-1)!.org).toBe("from-flag");
    await expect(viaEnv.run("project", "list", "--org", "Not A Slug")).rejects.toThrow("organization name");
    viaEnv.files.set(resolve("verdict.yaml"), "project: bot\norg: Not A Slug\n");
    await expect(setup().run("project", "list")).resolves.toBeTruthy();
    await expect(viaEnv.run("env", "list")).rejects.toThrow("org must be");
  });
});

describe("signing in on a server that runs sign-in itself", () => {
  const signIn = { kind: "browser" as const, start: "/v1/auth/device", token: "/v1/auth/device/token" };
  /** The server's own routes: a code to approve in the browser, then the key once it was approved. */
  function approval(answers: Array<"pending" | "slow_down" | "approved" | "denied" | "expired">) {
    const polls: string[] = [];
    const routes = async (path: string, init?: RequestInit) => {
      if (path === signIn.start) return Response.json({ deviceCode: "dev_1", userCode: "WXYZ-1234", verificationUri: `${SERVER}/activate`, expiresIn: 600, interval: 2 });
      if (path !== signIn.token) return undefined;
      polls.push(String(init?.body));
      const answer = answers.shift() ?? "pending";
      if (answer === "approved") return Response.json({ apiKey: "sk_team", keyId: "key_9", handle: "alice@example.com" });
      const type = { pending: "authorization_pending", slow_down: "slow_down", denied: "access_denied", expired: "expired_token" }[answer];
      return Response.json({ error: { type, message: type } }, { status: 400 });
    };
    return { routes, polls };
  }
  const env = { VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "" };

  it("shows the code, waits for the approval and keeps the key it is given", async () => {
    const server = approval(["pending", "slow_down", "approved"]);
    const t = setup({ env, signIn, routes: server.routes });
    expect((await t.run("login", "--hub", SERVER)).out).toEqual([`signed in to ${SERVER} as alice@example.com`]);
    expect(t.warn).toHaveBeenCalledWith(`Open ${SERVER}/activate and enter WXYZ-1234 (expires in 10 min). Waiting…`);
    expect(server.polls).toEqual(Array(3).fill('{"deviceCode":"dev_1"}'));
    expect(t.saved.get(SERVER)).toEqual({ hub: SERVER, apiKey: "sk_team", keyId: "key_9", handle: "alice@example.com" });
    // GitHub was never asked: how the person signed in is the server's business.
    expect(t.sent.map((r) => r.path)).toEqual(["/v1/hub/config", signIn.start, signIn.token, signIn.token, signIn.token]);
    expect((await t.run("project", "create", "bot")).out).toEqual([`created project bot on ${SERVER}`]);
  });

  it("stops when the approval is declined or the code runs out, saving nothing", async () => {
    const declined = setup({ env, signIn, routes: approval(["pending", "denied"]).routes });
    await expect(declined.run("login", "--hub", SERVER)).rejects.toThrow("declined in the browser");
    const expired = setup({ env, signIn, routes: approval(["expired"]).routes });
    await expect(expired.run("login", "--hub", SERVER)).rejects.toThrow("the sign-in code expired");
    const never = setup({ env, signIn, routes: approval([]).routes });
    await expect(never.run("login", "--hub", SERVER)).rejects.toThrow("the sign-in code expired");
    expect([declined, expired, never].every((t) => t.saved.size === 0)).toBe(true);
  });

  it("does not follow a sign-in route that points away from the server", async () => {
    const elsewhere = setup({ env, signIn: { kind: "browser", start: "https://evil.example/device", token: "/v1/auth/device/token" } });
    await expect(elsewhere.run("login", "--hub", SERVER)).rejects.toThrow("announced a sign-in route outside itself");
    const relative = setup({ env, signIn: { kind: "browser", start: "//evil.example/device", token: "/v1/auth/device/token" } });
    await expect(relative.run("login", "--hub", SERVER)).rejects.toThrow("outside itself");
    expect(elsewhere.sent.map((r) => r.path)).toEqual(["/v1/hub/config"]);
  });
});
