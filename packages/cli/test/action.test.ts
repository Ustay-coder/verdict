import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp } from "@verdict-ai/api";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The GitHub Action's script, run against a throwaway git repository and the built CLI (CI builds before testing).
const script = resolve(__dirname, "../../../actions/diff/run.sh");
const cli = resolve(__dirname, "../dist/bin.js");

const rubric = (billing: string, engineering: string) => `name: Owning team
defaultJudge: { type: decision, provider: typesafe }
criteria:
  - id: team
    name: Team
    choices: { support: How-to questions, billing: "${billing}", engineering: "${engineering}" }
`;
const cases = [["payments", "payments failed twice", "billing"], ["bugs", "the app has bugs", "engineering"], ["refund", "refund please", "billing"]]
  .map(([id, text, team]) => JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { team } })).join("\n");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "verdict-action-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(dir, "repo"), encoding: "utf8" }).trim();
  mkdirSync(join(dir, "repo", "rubrics"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "repo", "rubrics", "triage.yaml"), rubric("Invoices and payments", "Bugs and outages"));
  writeFileSync(join(dir, "repo", "cases.jsonl"), cases);
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "repo", "rubrics", "triage.yaml"), rubric("Invoices, payments and refund requests", "Outages and crashes"));
  git("commit", "-qam", "head");
  return { dir, base };
}

function run(dir: string, env: Record<string, string>) {
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const result = spawnSync("bash", [script], {
    cwd: join(dir, "repo"), encoding: "utf8",
    env: { ...process.env, RUBRIC: "rubrics/triage.yaml", DATA: "cases.jsonl", MOCK: "true", COMMENT: "false", VERDICT_CLI: `node ${cli}`, RUNNER_TEMP: join(dir, "tmp"), GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), ...env },
  });
  return { status: result.status, stdout: result.stdout, outputs: existsSync(join(dir, "out")) ? readFileSync(join(dir, "out"), "utf8") : "" };
}

describe("actions/diff/run.sh", () => {
  it("runs against the built CLI", () => { expect(existsSync(cli), `build the CLI first: ${cli}`).toBe(true); });

  it("compares the base-branch rubric with the pull request's, writes the comment and summary, and gates on regressions", () => {
    const { dir, base } = repo();
    try {
      const gated = run(dir, { BASE_REF: base, FAIL_ON: "regressed,error" });
      expect(gated.status).toBe(1);
      expect(gated.stdout.split("\n")[0]).toBe("<!-- verdict-diff:rubrics/triage.yaml -->");
      expect(gated.stdout).toContain("rubric change — only the rubric's judgment differs");
      expect(gated.stdout).toContain("| ✗ | bugs | engineering | support | engineering |");
      expect(gated.stdout).toContain("**Failed** (exit 1; fail-on: `regressed,error`).");
      expect(gated.outputs).toBe("kind=rubric_change\nregressed=1\n");
      expect(readFileSync(join(dir, "summary"), "utf8")).toContain("| ✓ | refund | support | billing | billing |");
      expect(run(dir, { BASE_REF: base, FAIL_ON: "" }).status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("says so for a rubric the base branch does not have, and shows why when the CLI cannot compare", () => {
    const { dir, base } = repo();
    try {
      const fresh = run(dir, { BASE_REF: base, RUBRIC: "rubrics/new.yaml" });
      expect(fresh.status).toBe(0);
      expect(fresh.stdout).toContain("New rubric: there is no base version");
      expect(fresh.outputs).toBe("kind=new\nregressed=0\n");
      writeFileSync(join(dir, "repo", "rubrics", "triage.yaml"), "name: broken\ncriteria: []\n");
      const broken = run(dir, { BASE_REF: base });
      expect(broken.status).toBe(1);
      expect(broken.stdout).toMatch(/Could not compare:\n\n```\nerror: invalid rubric/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports both runs and the comparison to a server when asked, and never fails the job over the server", async () => {
    const offline = (keywords: string) => `name: Wants an agent\ncriteria:\n  - id: wants\n    name: Wants an agent\n    scale: { type: binary, labels: [no, yes] }\n    judge: { type: benchmark, method: keywords, keywords: [${keywords}] }\n`;
    const gold = [["explicit", "connect me to an agent", "yes"], ["kim-private", "Kim Minsu 010-1234-5678 wants a human", "yes"], ["faq", "opening hours", "no"]]
      .map(([id, text, wants]) => JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { wants } })).join("\n");
    const { dir } = repo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: join(dir, "repo"), encoding: "utf8" }).trim();
    writeFileSync(join(dir, "repo", "rubrics", "intent.yaml"), offline("agent"));
    writeFileSync(join(dir, "repo", "gold.jsonl"), gold);
    git("add", "-A"); git("commit", "-qm", "offline base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "repo", "rubrics", "intent.yaml"), offline("agent, human"));

    // A real server on a local port: the script runs the built CLI in its own process.
    const store = new MemoryStore();
    await store.control.createProject({ tenantId: "acme", name: "bot", createdAt: "2026-11-01T00:00:00.000Z" });
    const app = createApp({ engine: new Engine({ store }), auth: { resolve: (k) => (k === "sk_ci" ? "acme" : undefined) } });
    const bodies: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      const answer = await app.request(req.url ?? "/", { method: req.method, headers: req.headers as Record<string, string>, body: body || undefined });
      res.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const act = (env: Record<string, string>) => new Promise<{ status: number | null; stdout: string }>((done) => {
      mkdirSync(join(dir, "tmp"), { recursive: true });
      const child = spawn("bash", [script], {
        cwd: join(dir, "repo"),
        env: { ...process.env, RUBRIC: "rubrics/intent.yaml", DATA: "gold.jsonl", BASE_REF: base, FAIL_ON: "regressed", COMMENT: "false", VERDICT_CLI: `node ${cli}`, RUNNER_TEMP: join(dir, "tmp"), REPORT: "true", PROJECT: "bot", SERVER_KEY: "sk_ci", HEAD_SHA: "abc123", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...env },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.on("close", (status) => done({ status, stdout }));
    });
    try {
      const reported = await act({ SERVER: url });
      expect(reported.status).toBe(0);
      expect(reported.stdout).toMatch(/Reported to the Verdict project \(comparison cmp_[0-9a-f]{20}\)\./);
      expect(reported.stdout).not.toContain(url);
      const scope = { tenantId: "acme", project: "bot" };
      expect((await store.control.listRunReports(scope)).map((r) => [r.name, r.source?.commit])).toEqual([["intent", "abc123"], ["intent", "abc123"]]);
      expect(await store.control.listComparisonReports(scope)).toMatchObject([{ kind: "rubric_change", criteria: [{ counts: { fixed: 1 } }] }]);
      for (const leak of ["kim-private", "Kim Minsu", "010-1234-5678"]) expect(bodies.join("\n")).not.toContain(leak);

      const unreachable = await act({ SERVER: url, SERVER_KEY: "sk_wrong" });
      expect(unreachable.status).toBe(0);
      expect(unreachable.stdout).toContain("> Could not report to the Verdict server: error:");
      expect(unreachable.stdout).toContain("::warning::Verdict report failed");
      const mocked = await act({ SERVER: url, MOCK: "true" });
      expect(mocked.stdout).toContain("Not reported: mock runs are never reported.");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

// The walk-through in examples/control-plane: a self-hosted server, CI reporting, promotion, and a service that reads
// prod. This is the M1a "done" check (docs/design/control-plane.md §10), kept running so the example cannot rot.
describe("examples/control-plane/demo.sh", () => {
  it("reports from CI, promotes, and the service judges with the version prod runs — through a rollback", async () => {
    const demo = resolve(__dirname, "../../../examples/control-plane/demo.sh");
    // A port the system says is free. A number drawn at random could be one another test's server was given.
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = String((probe.address() as AddressInfo).port);
    await new Promise((done) => probe.close(done));
    const result = spawnSync("bash", [demo], { encoding: "utf8", env: { ...process.env, VERDICT_CLI: `node ${cli}`, PORT: port, VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "", VERDICT_PROJECT: "", VERDICT_API_URL: "" } });
    expect(result.status, result.stderr).toBe(0);
    const judged = result.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { message: string; wants: boolean; versionId: string; source: string });
    const [first, second, afterPromotion, afterRollback] = judged.map((j) => [j.message.includes("human") ? "human" : "agent", j.wants, j.source]);
    expect([first, second, afterPromotion, afterRollback]).toEqual([["agent", true, "server"], ["human", false, "server"], ["human", true, "server"], ["human", false, "server"]]);
    // The service ran what prod pointed at each time: v1, v1, v2, and v1 again after the rollback.
    expect(new Set(judged.map((j) => j.versionId)).size).toBe(2);
    expect(judged[3]!.versionId).toBe(judged[0]!.versionId);
    expect(judged[2]!.versionId).not.toBe(judged[0]!.versionId);
    // Reporting says what it did on stderr, so it never mixes into a command's own output.
    expect(result.stderr).toMatch(/reported comparison cmp_[0-9a-f]{20} \(rubric_change\)/);
    expect(result.stdout).toContain("rollback by an unnamed key\t“checking a complaint”");
    // The example directory itself is left as it was.
    expect(existsSync(resolve(__dirname, "../../../examples/control-plane/verdict.lock"))).toBe(false);
  }, 120000);

  it("stops at once and shows the server's own log when its server cannot start", async () => {
    const demo = resolve(__dirname, "../../../examples/control-plane/demo.sh");
    // The port is held by something else, which is what a failed start looked like in CI: a wait, then "fetch failed".
    const holder = createServer((_req, res) => { res.writeHead(500).end(); });
    await new Promise<void>((done) => holder.listen(0, done));
    try {
      const started = Date.now();
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const child = spawn("bash", [demo], { env: { ...process.env, VERDICT_CLI: `node ${cli}`, PORT: String((holder.address() as AddressInfo).port), VERDICT_HUB_URL: "", VERDICT_HUB_KEY: "", VERDICT_PROJECT: "", VERDICT_API_URL: "" } });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => { stdout += String(d); });
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("close", (status) => done({ status, stdout, stderr }));
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("did not come up. Its log:");
      expect(result.stderr).toContain("EADDRINUSE");
      expect(result.stdout).not.toContain("== 2.");
      expect(Date.now() - started).toBeLessThan(10000);
    } finally { await new Promise((done) => holder.close(done)); }
  }, 60000);

  it("runs the same loop against a server that is already there, in a project of its own that it removes", async () => {
    const demo = resolve(__dirname, "../../../examples/control-plane/demo.sh");
    const store = new MemoryStore();
    await store.control.createProject({ tenantId: "acme", name: "support-bot", createdAt: "2026-11-01T00:00:00.000Z" });
    const app = createApp({ engine: new Engine({ store }), auth: { resolve: (k) => (k === "sk_check" ? "acme" : undefined) }, routes: ["hub", "control"] });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const answer = await app.request(req.url ?? "/", { method: req.method, headers: req.headers as Record<string, string>, body: body.length ? body : undefined });
      const headers = Object.fromEntries(answer.headers);
      res.writeHead(answer.status, headers).end(Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const child = spawn("bash", [demo], { env: { ...process.env, VERDICT_CLI: `node ${cli}`, VERDICT_HUB_URL: url, VERDICT_HUB_KEY: "sk_check", VERDICT_PROJECT: "", VERDICT_API_URL: "", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" } });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => { stdout += String(d); });
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("close", (status) => done({ status, stdout, stderr }));
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`== 1. A server that is already running: ${url}`);
      expect(result.stdout).toMatch(/created project demo-\d+-\d+ on /);
      expect(result.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as { wants: boolean }).wants)).toEqual([true, false, true, false]);
      // Its own project is gone; the one that was there is untouched.
      expect((await store.control.listProjects("acme")).map((p) => p.name)).toEqual(["support-bot"]);
    } finally { server.close(); }
  }, 120000);
});
