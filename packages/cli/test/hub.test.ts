import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolve } from "node:path";
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp, type Auth, type KeyManager } from "@verdict-ai/api";
import { registerHub } from "../src/commands/hub.js";
import { registerPublish } from "../src/commands/publish.js";
import { registerRun } from "../src/commands/run.js";
import { registerPull } from "../src/commands/pull.js";
import { registerFork } from "../src/commands/fork.js";
import { registerVersion } from "../src/commands/version.js";
import { githubDeviceFlow } from "../src/hub/device.js";
import type { HubCredentials } from "../src/hub/credentials.js";
import type { HubDependencies } from "../src/hub/deps.js";

class MemoryKeys implements Auth, KeyManager {
  keys = new Map<string, { id: string; tenantId: string; revoked: boolean }>();
  resolve(key: string | undefined) { const k = key ? this.keys.get(key) : undefined; return k && !k.revoked ? k.tenantId : undefined; }
  async createKey(tenantId: string) { const key = `vk_${this.keys.size + 1}`, id = `key_${this.keys.size + 1}`; this.keys.set(key, { id, tenantId, revoked: false }); return { id, key, prefix: key }; }
  async revokeKey(id: string, tenantId?: string) { const k = [...this.keys.values()].find((x) => x.id === id && x.tenantId === tenantId); if (!k) return false; k.revoked = true; return true; }
  async listKeys() { return []; }
}

const HUB = "https://hub.example";
const card = `name: Wants an agent
defaultJudge: { type: decision, provider: mock }
criteria:
  - { id: wants, name: Wants an agent, scale: { type: binary, labels: [no, yes] }, threshold: 0.6 }
`;
const cases = [
  { id: "explicit", name: "explicit", inputs: [{ type: "text", text: "상담원 연결해 주세요" }], expected: { wants: "yes" }, labelSource: "human" },
  { id: "kim-private", name: "kim", inputs: [{ type: "text", text: "김민수 고객 010-1234-5678" }], expected: { wants: "yes" }, labelSource: "human" },
].map((c) => JSON.stringify(c)).join("\n");

/** GitHub's device endpoints: pending once, then slow_down, then a token for account 42. */
function deviceGithub() {
  let polls = 0;
  return async (url: string) => {
    if (url === "https://github.com/login/device/code") return Response.json({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url === "https://github.com/login/oauth/access_token") {
      polls++;
      return Response.json(polls === 1 ? { error: "authorization_pending" } : polls === 2 ? { error: "slow_down", interval: 10 } : { access_token: "gho_token" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "alice" });
    return undefined;
  };
}

function setup(opts: { interactive?: boolean; confirm?: boolean; tamper?: (body: { publication: { version: { rubric: { name: string } } } }) => void } = {}) {
  const keys = new MemoryKeys();
  const hubStore = new MemoryStore();
  const github = deviceGithub();
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const fromGithub = await github(url);
    if (fromGithub) return fromGithub;
    if (!url.startsWith(HUB)) throw new Error(`unexpected ${url}`);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : "" });
    const res = await hub.request(url.slice(HUB.length), init);
    if (!opts.tamper || !url.includes("/v1/public/rubrics/")) return res;
    const body = await res.json() as Parameters<NonNullable<typeof opts.tamper>>[0];
    opts.tamper(body);
    return Response.json(body);
  }) as typeof fetch;
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
  const hub = createApp({ engine: new Engine({ store: hubStore }), auth: keys, keys, github: { clientId: "Iv1.client", fetch: net } });
  const files = new Map<string, string>([[resolve("intent.yaml"), card], [resolve("cases.jsonl"), cases]]);
  let saved: HubCredentials | undefined;
  const local = new Engine();
  const out = vi.fn(), warn = vi.fn(), sleeps: number[] = [];
  const deps: HubDependencies = {
    engine: () => local, remote: () => undefined, out, fail: vi.fn(), warn, exitCode: vi.fn(),
    readText: async (p) => { const t = files.get(resolve(p)); if (t === undefined) throw new Error(`missing ${p}`); return t; },
    readBytes: async (p) => new TextEncoder().encode(files.get(resolve(p)) ?? ""),
    lockIo: { read: async (p) => files.get(resolve(p)), write: async (p, t) => { files.set(resolve(p), t); } },
    writeNew: async (p, t, overwrite) => { if (!overwrite && files.has(resolve(p))) throw new Error(`${p} exists; pass --force to replace it`); files.set(resolve(p), t); },
    credentials: { read: async () => saved, write: async (c) => { saved = c; }, remove: async () => { saved = undefined; } },
    env: { VERDICT_HUB_URL: HUB, VERDICT_API_KEY: "team-server-key" }, fetch: net, sleep: async (ms) => { sleeps.push(ms); },
    confirm: async () => opts.confirm ?? true, interactive: () => opts.interactive ?? false,
  };
  const program = new Command();
  registerHub(program, deps); registerPublish(program, deps); registerRun(program, deps); registerPull(program, deps); registerFork(program, deps); registerVersion(program, deps);
  const run = async (...args: string[]) => { out.mockClear(); await program.parseAsync(args, { from: "user" }); return out.mock.calls.map((c) => String(c[0])); };
  return { run, out, warn, sleeps, hubStore, keys, files, requests, credentials: () => saved };
}

describe("verdict hub and publish", () => {
  it("signs in with the device flow, previews, publishes only the named cases, lists, withdraws and signs out", async () => {
    const t = setup();
    expect(await t.run("hub", "login")).toEqual([`signed in to ${HUB} as alice`]);
    expect(t.warn).toHaveBeenCalledWith("Open https://github.com/login/device and enter ABCD-1234 (expires in 15 min). Waiting…");
    expect(t.sleeps).toEqual([5000, 5000, 10000]);
    expect(t.credentials()).toEqual({ hub: HUB, apiKey: "vk_1", keyId: "key_1", handle: "alice" });
    expect(await t.run("hub", "whoami")).toEqual([`alice on ${HUB}`]);

    // A run over both cases; only "explicit" is named, so only it becomes public.
    const runId = await localRunId(t);
    const dry = await t.run("publish", "intent.yaml", "--slug", "agent-intent", "--license", "CC-BY-4.0", "--cases", "cases.jsonl", "--case", "explicit", "--run", runId, "--dry-run");
    expect(dry[0]).toBe(`preview on ${HUB} — this is exactly what would be public:`);
    expect(dry[1]).toMatch(/^ {2}alice\/agent-intent at rv_\w+ · Wants an agent · noul · CC-BY-4\.0$/);
    expect(dry).toContain("  cases: 1 (explicit)");
    expect(dry).toContain(`  run ${runId}: 2 cases, includes private cases — numbers only`);
    expect(t.hubStore.publications.size).toBe(0);

    const published = await t.run("publish", "intent.yaml", "--slug", "agent-intent", "--license", "CC-BY-4.0", "--cases", "cases.jsonl", "--case", "explicit", "--run", runId, "--yes");
    expect(published.at(-1)).toMatch(/^published alice\/agent-intent at rv_\w+ \(pub_\w+\)$/);
    const stored = JSON.stringify([...t.hubStore.publications.values()]);
    for (const leak of ["kim-private", "김민수", "010-1234-5678"]) expect(stored).not.toContain(leak);
    // Not stored is not enough: what was not named must not be sent. The run had two cases; only "explicit" was named.
    const sent = t.requests.filter((r) => r.url.includes("/v1/publications")).map((r) => r.body).filter(Boolean);
    expect(sent).toHaveLength(3);
    for (const body of sent) for (const leak of ["kim", "김민수", "010-1234-5678", "eval_", "evaluationId", "results"]) expect(body, leak).not.toContain(leak);
    expect(sent[0]).toContain('"caseId":"explicit"');

    const [listed] = await t.run("hub", "list");
    const pubId = listed!.split("\t")[0]!;
    expect(listed).toMatch(/^pub_\w+\talice\/agent-intent\trv_\w+\t/);
    expect(await t.run("withdraw", pubId)).toEqual([`withdrew ${pubId}`]);
    expect((await t.run("hub", "list"))[0]).toMatch(/\twithdrawn /);

    expect(await t.run("hub", "logout")).toEqual([`signed out of ${HUB}`]);
    expect(t.credentials()).toBeUndefined();
    expect(t.keys.resolve("vk_1")).toBeUndefined();
  });

  it("asks before publishing at a terminal, refuses without one unless --yes, and requires naming the cases", async () => {
    const declined = setup({ interactive: true, confirm: false });
    await declined.run("hub", "login");
    expect(await declined.run("publish", "intent.yaml", "--slug", "s", "--license", "CC0-1.0")).toContain("not published");
    expect(declined.hubStore.publications.size).toBe(0);
    const ci = setup();
    await ci.run("hub", "login");
    await expect(ci.run("publish", "intent.yaml", "--slug", "s", "--license", "CC0-1.0")).rejects.toThrow(/pass --yes/);
    await expect(ci.run("publish", "intent.yaml", "--slug", "s", "--license", "CC0-1.0", "--cases", "cases.jsonl")).rejects.toThrow(/name the cases to publish/);
    await expect(ci.run("publish", "intent.yaml", "--slug", "s", "--license", "CC0-1.0", "--cases", "cases.jsonl", "--case", "nope")).rejects.toThrow(/no case nope/);
    const rejected = await ci.run("publish", "intent.yaml", "--slug", "s", "--license", "WTFPL", "--yes").catch((e: Error) => e.message);
    expect(rejected).toMatch(/the hub rejected this publication/);
    expect(ci.out.mock.calls.map((c) => String(c[0]))).toContain(`${HUB} would not publish this:`);
  });

  it("needs a sign-in for everything but login", async () => {
    const t = setup();
    for (const args of [["hub", "whoami"], ["hub", "list"], ["withdraw", "pub_x"], ["publish", "intent.yaml", "--slug", "s", "--license", "CC0-1.0"]]) {
      await expect(t.run(...args)).rejects.toThrow(/not signed in to https:\/\/hub\.example; run `verdict hub login`/);
    }
  });
});

describe("verdict pull and fork hub:", () => {
  const publishCard = async (t: ReturnType<typeof setup>) => {
    await t.run("hub", "login");
    const published = await t.run("publish", "intent.yaml", "--slug", "agent-intent", "--license", "CC-BY-4.0", "--cases", "cases.jsonl", "--case", "explicit", "--yes");
    return /at (rv_\w+)/.exec(published.at(-1)!)![1]!;
  };

  it("pulls a card exactly, with its public cases and licence, sending no key", async () => {
    const t = setup();
    const versionId = await publishCard(t);
    t.requests.length = 0;
    expect(await t.run("pull", "hub:alice/agent-intent")).toEqual([
      `wrote agent-intent.yaml (hub:alice/agent-intent@${versionId}, CC-BY-4.0)`,
      "wrote agent-intent.cases.jsonl (1 public case(s)); `verdict run -r <rubric> -d agent-intent.cases.jsonl` checks them yourself",
    ]);
    expect(t.requests.map((r) => r.authorization)).toEqual([null]);
    const file = t.files.get(resolve("agent-intent.yaml"))!;
    expect(file.split("\n")[0]).toBe(`# pulled from hub:alice/agent-intent@${versionId} (CC-BY-4.0) — ${HUB}/hub/alice/agent-intent?version=${versionId}`);
    expect((await t.run("version", "freeze", "agent-intent.yaml")).join("\n")).toContain(versionId);
    const lock = t.files.get(resolve("verdict.lock"))!;
    expect(lock).toContain(`ref: hub:alice/agent-intent@${versionId}`);
    expect(lock).toContain("license: CC-BY-4.0");
    const cases = t.files.get(resolve("agent-intent.cases.jsonl"))!.trim().split("\n").map((l) => JSON.parse(l) as { id: string; visibility: string });
    expect(cases.map((c) => [c.id, c.visibility])).toEqual([["explicit", "public"]]);
    // The pulled cases run as they are.
    expect((await t.run("run", "-r", "agent-intent.yaml", "-d", "agent-intent.cases.jsonl"))[0]).toMatch(/^run_\w+ /);

    await expect(t.run("pull", "hub:alice/agent-intent")).rejects.toThrow(/exists; pass --force/);
    expect(await t.run("pull", `hub:alice/agent-intent@${versionId}`, "--to", "copy.yaml", "--no-cases")).toHaveLength(1);
    await expect(t.run("pull", "hub:alice/nothing")).rejects.toThrow(/no card alice\/nothing/);
    // Without `hub:` it is neither a card nor a rubric on a team's server, and the message says how to write both.
    await expect(t.run("pull", "alice/agent-intent")).rejects.toThrow(/expected a hub card \(hub:owner\/slug\[@rv_…\]\) or a rubric on your team's server/);
  });

  it("forks a card: the hub version becomes the recorded parent, and freezing the edit lists what changed", async () => {
    const t = setup();
    const versionId = await publishCard(t);
    expect(await t.run("fork", `hub:alice/agent-intent@${versionId}`, "--to", "mine.yaml", "--note", "stricter", "--no-cases")).toEqual([
      `wrote mine.yaml (fork of hub:alice/agent-intent@${versionId}); edit it, then \`verdict version freeze mine.yaml\``,
    ]);
    expect(t.files.get(resolve("mine.yaml"))!.split("\n")[0]).toMatch(/^# forked from hub:alice\/agent-intent@rv_\w+ \(CC-BY-4\.0\)/);
    expect(t.files.has(resolve("mine.cases.jsonl"))).toBe(false);
    t.files.set(resolve("mine.yaml"), t.files.get(resolve("mine.yaml"))!.replace("threshold: 0.6", "threshold: 0.7"));
    const frozen = (await t.run("version", "freeze", "mine.yaml")).join("\n");
    expect(frozen).toContain(versionId);
    expect(frozen).toContain("policy");
    const lock = t.files.get(resolve("verdict.lock"))!;
    expect(lock).toMatch(new RegExp(`mine\\.yaml:[\\s\\S]*parent: ${versionId}[\\s\\S]*origin:`));
  });

  it("refuses a card whose rubric does not freeze to the version the hub names", async () => {
    const t = setup({ tamper: (body) => { body.publication.version.rubric.name = "Something else"; } });
    await publishCard(t);
    await expect(t.run("pull", "hub:alice/agent-intent")).rejects.toThrow(/sent a rubric that freezes to rv_\w+, not rv_\w+; nothing was written/);
    await expect(t.run("fork", "hub:alice/agent-intent", "--to", "x.yaml")).rejects.toThrow(/nothing was written/);
    expect(t.files.has(resolve("agent-intent.yaml"))).toBe(false);
    expect(t.files.has(resolve("x.yaml"))).toBe(false);
  });
});

describe("githubDeviceFlow", () => {
  const flow = (answer: Record<string, unknown>) => githubDeviceFlow({
    clientId: "c", prompt: () => {}, sleep: async () => {},
    fetch: (async (url: string) => Response.json(String(url).endsWith("/device/code") ? { device_code: "d", user_code: "U", interval: 1 } : answer)) as unknown as typeof fetch,
  });
  it("stops on an expired code or a declined sign-in, and reports anything else GitHub says", async () => {
    await expect(flow({ error: "expired_token" })).rejects.toThrow(/expired/);
    await expect(flow({ error: "access_denied" })).rejects.toThrow(/declined/);
    await expect(flow({ error: "device_flow_disabled", error_description: "Device Flow must be enabled" })).rejects.toThrow(/Device Flow must be enabled/);
  });
});

it("still lets the hub see when every case of a run is published, and sends stand-ins for the rest", async () => {
  const t = setup();
  await t.run("hub", "login");
  const runId = await localRunId(t);
  const all = await t.run("publish", "intent.yaml", "--slug", "open", "--license", "CC0-1.0", "--cases", "cases.jsonl", "--all-cases", "--run", runId, "--dry-run");
  expect(all).toContain(`  run ${runId}: 2 cases, all public — anyone can repeat it`);
  const some = await t.run("publish", "intent.yaml", "--slug", "open", "--license", "CC0-1.0", "--cases", "cases.jsonl", "--case", "kim-private", "--run", runId, "--dry-run");
  expect(some).toContain(`  run ${runId}: 2 cases, includes private cases — numbers only`);
  const body = JSON.parse(t.requests.at(-1)!.body) as { runs: Array<{ run: { cases: Array<{ caseId: string }> } & Record<string, unknown>; report: Record<string, unknown> }> };
  expect(body.runs[0]!.run.cases).toEqual([{ caseId: expect.stringMatching(/^withheld_[0-9a-f-]{36}$/) }, { caseId: "kim-private" }]);
  expect(Object.keys(body.runs[0]!.run).sort()).toEqual(["cases", "counts", "datasetVersionId", "fingerprint", "id", "rubricVersionId", "startedAt", "status"]);
  expect(Object.keys(body.runs[0]!.report).sort()).toEqual(["agreed", "criteria", "decided", "labelSources", "splits"]);
});

async function localRunId(t: ReturnType<typeof setup>): Promise<string> {
  const lines = await t.run("run", "-r", "intent.yaml", "-d", "cases.jsonl");
  return lines[0]!.split(" ")[0]!;
}
