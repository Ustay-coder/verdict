import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolve } from "node:path";
import YAML from "yaml";
import { compareRuns, createDatasetVersion, Engine, freezeRubric, runCases, type Evaluation } from "@verdict-ai/core";
import { registerEvaluate } from "../src/commands/evaluate.js";
import { guardRubric, type GuardIo } from "../src/versions/guard.js";
import { renderComparisonMarkdown } from "../src/versions/render.js";

const rubricText = `name: Wants an agent
defaultJudge: { type: decision, provider: mock }
criteria:
  - { id: wants, name: Wants an agent, scale: { type: binary, labels: [no, yes] } }
`;

async function setup(entry: Record<string, unknown> | "frozen") {
  const files = new Map<string, string>([[resolve("intent.yaml"), rubricText]]);
  const version = await freezeRubric(YAML.parse(rubricText));
  const lockEntry = entry === "frozen" ? { version: version.id } : entry;
  files.set(resolve("verdict.lock"), YAML.stringify({ lockVersion: 1, rubrics: { "intent.yaml": lockEntry } }));
  const warn = vi.fn();
  const io: GuardIo = {
    lockIo: { read: async (p) => files.get(resolve(p)), write: async (p, t) => { files.set(resolve(p), t); } },
    readText: async (p) => files.get(resolve(p)) ?? "",
    warn,
  };
  return { files, io, warn, version };
}

const evaluated = async (model = "mock-decision"): Promise<Evaluation> => {
  const ev = await new Engine().evaluate({ rubric: YAML.parse(rubricText), subject: { inputs: [{ type: "text", text: "connect me" }] } });
  for (const c of ev.criteria) for (const r of c.ratings) if (r.judgeType === "decision" && r.raw) r.raw.resolvedModel = model;
  return ev;
};

describe("the verdict.lock guard", () => {
  it("does nothing for files outside the lock, stored ids and mock runs", async () => {
    const { io, warn } = await setup({});
    for (const [ref, opts] of [["other.yaml", {}], ["rub_123", {}], ["intent.yaml", { mock: true, strict: true }], ["intent.yaml", {}]] as const) {
      await (await guardRubric(ref, opts, io)).after([await evaluated()]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, or with --strict stops before any judge runs, when the file no longer matches its locked version", async () => {
    const { io, warn, files } = await setup({ version: "rv_00000000000000000000" });
    await guardRubric("intent.yaml", {}, io);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^warning: verdict\.lock: intent\.yaml changed since it was locked \(locked rv_0+, now rv_\w+\); review the change/));
    await expect(guardRubric("intent.yaml", { strict: true }, io)).rejects.toThrow(/verdict\.lock: intent\.yaml changed since it was locked/);
    expect(files.get(resolve("verdict.lock"))).toContain("rv_00000000000000000000");
  });

  it("compares the questions sent and the answering model with the locked run", async () => {
    const ev = await evaluated();
    const sent = (await runCases(new Engine(), await freezeRubric(YAML.parse(rubricText)), await createDatasetVersion([{ id: "a", name: "a", inputs: [{ type: "text", text: "x" }], expected: { wants: "yes" } }]))).run.fingerprint;
    const { version } = await setup({});
    const locked = (questionsHash: string, resolved: string) => ({ version: version.id, verified: { runId: "run_1", questionsHash, models: [{ provider: "mock", resolved, verified: true }] } });

    const same = await setup(locked(sent.questionsHash!, "mock-decision"));
    await (await guardRubric("intent.yaml", { strict: true }, same.io)).after([ev]);
    expect(same.warn).not.toHaveBeenCalled();

    const moved = await setup(locked("0".repeat(64), "mock-decision-old"));
    await (await guardRubric("intent.yaml", {}, moved.io)).after([ev]);
    expect(moved.warn).toHaveBeenCalledWith(expect.stringMatching(/the questions sent differ from those of run_1 .*; the answering model changed: mock\/mock-decision-old → mock\/mock-decision; re-verify with `verdict run -r intent.yaml -d <cases>`$/));
    await expect((await guardRubric("intent.yaml", { strict: true }, moved.io)).after([ev])).rejects.toThrow(/answering model changed/);
  });

  it("guards `verdict eval --strict` before the engine is asked anything", async () => {
    const { io } = await setup({ version: "rv_00000000000000000000" });
    const engine = new Engine();
    const program = new Command();
    registerEvaluate(program, {
      loadRubric: async () => YAML.parse(rubricText), parseInput: (s: string) => ({ type: "text" as const, text: s }), readStdin: async () => "",
      remote: () => undefined, localEngine: () => engine, stdout: vi.fn(), setExitCode: vi.fn(),
      guard: (ref, opts) => guardRubric(ref, opts, io),
    });
    await expect(program.parseAsync(["eval", "-r", "intent.yaml", "-i", "hello", "--strict"], { from: "user" })).rejects.toThrow(/changed since it was locked/);
    expect(await engine.store.listEvaluations()).toEqual([]);
  });
});

describe("diff --markdown", () => {
  it("puts the kind on top, a table per criterion, and folds the cases that changed", async () => {
    const triage = (billing: string) => ({ name: "Team", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "team", name: "Team", choices: { support: "How-to questions", billing, engineering: "Bugs and outages" } }] });
    const data = await createDatasetVersion([{ id: "r|1", name: "refund | please", inputs: [{ type: "text", text: "refund please" }], expected: { team: "billing" } }]);
    const engine = new Engine();
    const [a, b] = [await freezeRubric(triage("Invoices and payments")), await freezeRubric(triage("Invoices, payments and refund requests"))];
    const md = renderComparisonMarkdown(compareRuns({ ...(await runCases(engine, a, data)), version: a }, { ...(await runCases(engine, b, data)), version: b }, data), "Verdict diff `x.yaml`");
    expect(md.split("\n")[0]).toBe("### 🔁 Verdict diff `x.yaml`: rubric change — only the rubric's judgment differs");
    expect(md).toContain("| `team` | 0% → 100% (n=1) | 1 | 0 | 0 | 0 · 0 · 0 | 1 (1 · 1) |");
    expect(md).toContain("| ✓ | refund \\| please | support | billing | billing |");
    expect(md).toContain("<details><summary><code>team</code>: 1 case(s) that changed or need a look</summary>");
  });
});
