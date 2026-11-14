/**
 * examples/landing-page scores an AI-made page round by round. Its rubric was frozen before the first page was
 * generated, so it is held to that: the file still freezes to the locked version, any failed gate makes the score 0,
 * and the two gates that are rules (a real next step, no placeholders) catch what they say without calling a model.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRubricText } from "@verdict-ai/core";

const at = (name: string) => fileURLToPath(new URL(`../../../examples/landing-page/${name}`, import.meta.url));
const cli = resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist/bin.js");
const GATES = ["says_what", "cta_visible", "cta_real", "no_fabrication", "no_placeholder", "mobile_ok"];

function evaluate(html: string) {
  const dir = mkdtempSync(join(tmpdir(), "landing-"));
  try {
    writeFileSync(join(dir, "index.html"), html);
    writeFileSync(join(dir, "source.txt"), html);
    const r = spawnSync("node", [cli, "eval", "-r", at("landing-page.yaml"), "--mock", "--json",
      "-i", `page=${join(dir, "index.html")}`, "-i", `source=${join(dir, "source.txt")}`, "-i", `facts=${at("facts.md")}`],
    { encoding: "utf8", cwd: dir, env: { ...process.env, VERDICT_DATA_DIR: join(dir, ".verdict") } });
    expect(r.status, r.stderr).toBe(0);
    const evaluation = JSON.parse(r.stdout) as { aggregate: { score: number; gates: Array<{ criterion: string; passed: boolean }> } };
    return { score: evaluation.aggregate.score, gate: (id: string) => evaluation.aggregate.gates.find((g) => g.criterion === id)!.passed };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("examples/landing-page", () => {
  it("still freezes to the version locked before the first round", () => {
    const r = spawnSync("node", [cli, "version", "verify", "--lock", at("verdict.lock")], { encoding: "utf8", cwd: at(".") });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("has six gates that weigh nothing on their own and four scored criteria", () => {
    const rubric = loadRubricText(readFileSync(at("landing-page.yaml"), "utf8"));
    expect(rubric.criteria.filter((c) => c.weight === 0).map((c) => c.id)).toEqual(GATES);
    expect(rubric.criteria.filter((c) => c.weight > 0).map((c) => c.id)).toEqual(["value_prop", "audience", "proof", "first_run"]);
    expect(rubric.aggregation.gates?.map((g) => g.criterion)).toEqual(GATES);
    for (const id of GATES) expect(rubric.aggregation.formula).toContain(`${id}_n`);
  });

  it("gives 0 when a placeholder is left, whatever the models say", () => {
    const page = evaluate('<h1>Verdict</h1><a href="#">Get started</a><pre>npm install -g @verdict-ai/cli</pre>');
    expect(page.gate("no_placeholder")).toBe(false);
    expect(page.gate("cta_real")).toBe(true);
    expect(page.score).toBe(0);
  });

  it("fails the real-next-step gate when neither the install command nor the repository is on the page", () => {
    const page = evaluate('<h1>Verdict</h1><a href="https://docs.verdict-ai.dev">Docs</a>');
    expect(page.gate("cta_real")).toBe(false);
    expect(page.gate("no_placeholder")).toBe(true);
    expect(page.score).toBe(0);
  });

  it("passes both rule gates for a page with the repository link and nothing left to fill in", () => {
    const page = evaluate('<h1>Verdict</h1><a href="https://github.com/Ustay-coder/verdict">GitHub</a>');
    expect(page.gate("cta_real")).toBe(true);
    expect(page.gate("no_placeholder")).toBe(true);
  });
});
