import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolve } from "node:path";
import YAML from "yaml";
import { Engine } from "@verdict-ai/core";
import { registerDiff } from "../src/commands/diff.js";
import { registerFork } from "../src/commands/fork.js";
import { registerRescore } from "../src/commands/rescore.js";
import { registerRun } from "../src/commands/run.js";
import { registerVersion } from "../src/commands/version.js";
import type { VersionDependencies } from "../src/versions/workspace.js";

// The mock decision provider picks the choice whose description shares the most words with the state.
const triage = `name: Owning team
defaultJudge: { type: decision, provider: mock }
criteria:
  - id: team
    name: Team
    choices: { support: How-to questions, billing: Invoices and payments, engineering: Bugs and outages }
`;
const line = (id: string, text: string, team: string) => JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { team } });
const cases = [line("c1", "payments failed twice", "billing"), line("c2", "the app has bugs", "engineering"), line("c3", "refund please", "billing")].join("\n");
const agent = `name: Wants an agent
defaultJudge: { type: decision, provider: mock, options: { noul: 0.7 } }
criteria:
  - { id: wants, name: Wants an agent, scale: { type: binary, labels: [no, yes] }, threshold: 0.6 }
`;
const yesNo = [["a", "connect me to a person", "yes"], ["b", "thanks, all good", "no"]].map(([id, text, wants]) => JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { wants } })).join("\n");
const relabelled = [line("c1", "payments failed twice", "billing"), line("c2", "the app has bugs", "support"), line("c3", "refund please", "billing")].join("\n");

function setup(remote?: object) {
  const files = new Map<string, string>([["triage.yaml", triage], ["cases.jsonl", cases], ["cases-v2.jsonl", relabelled], ["agent.yaml", agent], ["agent-cases.jsonl", yesNo]].map(([k, v]) => [resolve(k!), v!]));
  const engine = new Engine();
  const out = vi.fn(), fail = vi.fn(), warn = vi.fn(), exitCode = vi.fn();
  const read = async (p: string) => files.get(resolve(p));
  const deps: VersionDependencies = {
    engine: () => engine, remote: () => remote as never, out, fail, warn, exitCode,
    readText: async (p) => { const t = await read(p); if (t === undefined) throw new Error(`missing ${p}`); return t; },
    readBytes: async (p) => new TextEncoder().encode((await read(p)) ?? ""),
    lockIo: { read, write: async (p, t) => { files.set(resolve(p), t); } },
    writeNew: async (p, t, overwrite) => { if (!overwrite && files.has(resolve(p))) throw new Error(`${p} exists`); files.set(resolve(p), t); },
  };
  const program = new Command();
  for (const register of [registerVersion, registerFork, registerRun, registerDiff, registerRescore]) register(program, deps);
  const run = async (...args: string[]) => { out.mockClear(); warn.mockClear(); await program.parseAsync(args, { from: "user" }); return out.mock.calls.map((c) => String(c[0])); };
  const lock = () => YAML.parse(files.get(resolve("verdict.lock"))!);
  return { files, engine, out, fail, warn, exitCode, run, lock };
}

describe("version commands (design §17.1, steps 1–8)", () => {
  it("re-scores recorded answers when only the policy changed, and asks the judges again with --rerun", async () => {
    const t = setup();
    await t.run("run", "-r", "agent.yaml", "-d", "agent-cases.jsonl");
    t.files.set(resolve("strict.yaml"), agent.replace("threshold: 0.6", "threshold: 0.75"));
    const diff = await t.run("diff", "--base", "agent.yaml", "--head", "strict.yaml", "-d", "agent-cases.jsonl");
    expect(t.warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^rv_\w+ differs from rv_\w+ only in policy: re-scored run_\w+'s recorded answers \(no judge calls\); --rerun to ask the judges again$/));
    expect(diff[0]).toMatch(/: policy change — the same answers read another way/);
    expect(diff[1]).toMatch(/^ {2}labels /);
    expect(diff).toContain("  ✗ a: 1 → 0 (expected yes)");
    expect(diff).toContain("  ✓ b: 1 → 0 (expected no)");
    const cmp = JSON.parse((await t.run("diff", "--base", "agent.yaml", "--head", "strict.yaml", "-d", "agent-cases.jsonl", "--json")).join("\n"));
    expect(t.warn.mock.calls[1]![0]).toMatch(/^reusing run_\w+ .* for rv_/);
    const head = await (t.engine.store as unknown as { getRun(id: string): Promise<{ usage: { decisionCalls: number }; rescoredFrom?: string }> }).getRun(cmp.head.runId);
    expect(head).toMatchObject({ usage: { decisionCalls: 0 }, rescoredFrom: cmp.base.runId });

    const rerun = JSON.parse((await t.run("diff", "--base", "agent.yaml", "--head", "strict.yaml", "-d", "agent-cases.jsonl", "--rerun", "--json")).join("\n"));
    expect(rerun.kind).toBe("policy_change");
    const asked = await (t.engine.store as unknown as { getRun(id: string): Promise<{ usage: { decisionCalls: number }; rescoredFrom?: string }> }).getRun(rerun.head.runId);
    expect(asked.usage.decisionCalls).toBe(2);
    expect(asked.rescoredFrom).toBeUndefined();
  });

  it("freeze, run, fork, diff with a CI gate, re-score new labels, export and verify", async () => {
    const t = setup();
    // 1–2. Freeze the original and run it; the lock records the version and the run's questions and models.
    const [frozen] = await t.run("version", "freeze", "triage.yaml");
    const base = frozen!.split(" ")[0]!;
    expect(base).toMatch(/^rv_[0-9a-f]{20}$/);
    const ran = await t.run("run", "-r", "triage.yaml", "-d", "cases.jsonl");
    expect(ran[0]).toMatch(new RegExp(`^run_\\w+  completed  ${base} × dsv_`));
    expect(ran).toContain("  team                 2/3 (67%)");
    expect(t.lock().rubrics["triage.yaml"]).toMatchObject({ version: base, verified: { questionsHash: expect.any(String), models: [{ provider: "mock", resolved: "mock-decision", verified: true }] } });

    // 3. Fork the exact version into a new file and edit one condition.
    await t.run("fork", base, "--to", "fork.yaml", "--note", "refunds belong to billing");
    expect(t.lock().rubrics["fork.yaml"]).toEqual({ parent: base, note: "refunds belong to billing" });
    const forkPath = resolve("fork.yaml");
    t.files.set(forkPath, t.files.get(forkPath)!.replace("Invoices and payments", "Invoices, payments and refund requests").replace("Bugs and outages", "Outages and crashes"));
    const forkFrozen = await t.run("version", "freeze", "fork.yaml");
    expect(forkFrozen[2]).toBe(`  forked from ${base}: question_text — refunds belong to billing`);

    // 4–5. Diff on the same cases: the base run is reused, the fork runs once; a regression trips the gate.
    const diff = await t.run("diff", "--base", "triage.yaml", "--head", "fork.yaml", "-d", "cases.jsonl", "--fail-on", "regressed");
    expect(t.warn.mock.calls[0]![0]).toMatch(/^reusing run_\w+ .* for rv_/);
    expect(diff[0]).toMatch(/: rubric change — only the rubric's judgment differs$/);
    expect(diff).toContain("  agreement 67% → 67% (n=3)");
    expect(diff).toContain("  ✓ c3: support → billing (expected billing)");
    expect(diff).toContain("  ✗ c2: engineering → support (expected engineering)");
    expect(t.warn).toHaveBeenLastCalledWith("diff: 1 regressed (--fail-on regressed)");
    expect(t.exitCode).toHaveBeenCalledWith(1);

    // 6. A label change: both stored runs are re-scored, nothing runs again, and the gate stays quiet.
    t.exitCode.mockClear();
    const stored = (await t.engine.store.listEvaluations({ limit: 1000 })).length;
    const again = await t.run("diff", "--base", "triage.yaml", "--head", "fork.yaml", "-d", "cases.jsonl", "--labels", "cases-v2.jsonl", "--fail-on", "regressed", "--json");
    const cmp = JSON.parse(again.join("\n"));
    expect(cmp.labels.rescored).toEqual({ base: true, head: true });
    expect(cmp.criteria[0].counts).toMatchObject({ fixed: 2, regressed: 0 });
    expect(t.exitCode).not.toHaveBeenCalled();
    expect((await t.engine.store.listEvaluations({ limit: 1000 })).length).toBe(stored);
    const runId = cmp.base.runId as string;
    const rescored = await t.run("rescore", runId, "-d", "cases-v2.jsonl");
    expect(rescored[0]).toBe(`${runId} re-scored against ${cmp.labels.datasetVersionId} (no judge calls)`);

    // 7–8. Export the fork's version; freezing the exported file names the same version. The lock verifies.
    const head = forkFrozen[0]!.split(" ")[0]!;
    await t.run("version", "export", head, "-o", "exported.yaml");
    const [exported] = await t.run("version", "freeze", "exported.yaml");
    expect(exported!.split(" ")[0]).toBe(head);
    expect(await t.run("version", "verify")).toEqual([`✓ exported.yaml: ${head}`, `✓ fork.yaml: ${head}`, `✓ triage.yaml: ${base}`]);
    expect(t.fail).not.toHaveBeenCalled();

    // An edited, un-frozen rubric file fails verification.
    t.files.set(resolve("triage.yaml"), triage.replace("How-to questions", "How-to and account questions"));
    const verify = await t.run("version", "verify");
    expect(verify[2]).toMatch(new RegExp(`^✗ triage.yaml: now rv_\\w+, locked ${base}$`));
    expect(t.fail).toHaveBeenCalledWith(expect.stringMatching(/1 rubric file\(s\) no longer match verdict.lock/));
  });

  it("refuses to run against a remote API, rejects unknown gate classes, and keeps an existing fork file", async () => {
    await expect(setup({}).run("version", "freeze", "triage.yaml")).rejects.toThrow(/local engine/);
    const t = setup();
    await expect(t.run("diff", "--base", "triage.yaml", "--head", "triage.yaml", "-d", "cases.jsonl", "--fail-on", "worse")).rejects.toThrow(/unknown --fail-on class worse/);
    await expect(t.run("diff", "--base", "triage.yaml", "--head", "triage.yaml")).rejects.toThrow(/--data is required/);
    await t.run("fork", "triage.yaml", "--to", "fork.yaml");
    await expect(t.run("fork", "triage.yaml", "--to", "fork.yaml")).rejects.toThrow(/exists/);
  });

  it("compares a version with itself as a repeat run, and lists stored versions", async () => {
    const t = setup();
    const out = await t.run("diff", "--base", "triage.yaml", "--head", "triage.yaml", "-d", "cases.jsonl", "--rerun");
    expect(out[0]).toMatch(/same conditions — a repeat of the same version$/);
    // --rerun: no "reusing" note, only the link to the comparison screen.
    expect(t.warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^see it in `verdict watch`: http:\/\/127\.0\.0\.1:4600\/compare\?base=run_\w+&head=run_\w+&labels=dsv_\w+$/)]);
    const [listed] = await t.run("version", "list");
    expect(listed).toMatch(/^rv_\w+\t.+\tOwning team$/);
  });
});
