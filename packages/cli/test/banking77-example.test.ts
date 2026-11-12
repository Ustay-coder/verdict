/**
 * examples/banking77 is what the project shows people first, so it is held to what it says: the cases are the ones
 * its script builds, every label is an intent of the rubric, and the table in its README is the saved run's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRubricText } from "@verdict-ai/core";

const at = (name: string) => fileURLToPath(new URL(`../../../examples/banking77/${name}`, import.meta.url));
const rubric = loadRubricText(readFileSync(at("intent.yaml"), "utf8"));
const cases = readFileSync(at("cases.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; inputs: { type: string; text: string }[]; expected: { intent: string } });
const intents = Object.keys(rubric.criteria[0]!.choices!);

describe("examples/banking77", () => {
  it("has ten cases for each of the rubric's eight intents, labelled with an intent the rubric offers", () => {
    expect(intents).toHaveLength(8);
    expect(cases).toHaveLength(80);
    for (const intent of intents) expect(cases.filter((c) => c.expected.intent === intent), intent).toHaveLength(10);
    expect(new Set(cases.map((c) => c.id)).size).toBe(80);
    for (const c of cases) expect(c.inputs).toEqual([{ type: "text", text: expect.any(String) }]);
  });

  it("builds its cases from the published file as it says: the first ten of each intent, text untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "banking77-"));
    try {
      // A stand-in for the published CSV: other intents in between, more than ten of each, and the quoting it uses.
      const rows = ["text,category", "What is my PIN?,get_physical_card"];
      for (let i = 1; i <= 12; i++) for (const intent of intents) rows.push(i === 2 ? `"Hello, it says ""pending"" (${intent})",${intent}` : `message ${i} of ${intent},${intent}`);
      writeFileSync(join(dir, "test.csv"), `${rows.join("\n")}\n`);
      const built = execFileSync("node", [at("build-cases.mjs"), join(dir, "test.csv")], { encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line) as (typeof cases)[number]);
      expect(built).toHaveLength(80);
      expect(built.map((c) => c.id)).toEqual(cases.map((c) => c.id));
      expect(built[0]).toEqual({ id: `${intents[0]}-01`, name: `${intents[0]}-01`, inputs: [{ type: "text", text: `message 1 of ${intents[0]}` }], expected: { intent: intents[0] } });
      expect(built[1]!.inputs[0]!.text).toBe(`Hello, it says "pending" (${intents[0]})`);
      expect(built.some((c) => c.inputs[0]!.text.startsWith("message 11 "))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("shows in its README the table the saved run printed, and quotes messages that are among the cases", () => {
    const readme = readFileSync(at("README.md"), "utf8"), run = readFileSync(at("run-2026-11-12.txt"), "utf8").split("\n");
    const shown = /```\n(Transfer intent[\s\S]*?)```/.exec(readme)![1]!.trimEnd().split("\n");
    expect(shown).toEqual(run.slice(0, shown.length));
    // The repository's front page opens with the same run.
    const front = /```text\n(Transfer intent[\s\S]*?)\n {2}…\n```/.exec(readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8"))![1]!.split("\n");
    expect(front).toEqual(run.slice(0, front.length));
    expect(front.length).toBeGreaterThan(6);
    const quoted = [...readme.matchAll(/^\| "([^"]+)" \|/gm)].map((m) => m[1]);
    expect(quoted).toHaveLength(3);
    for (const text of quoted) {
      const found = cases.find((c) => c.inputs[0]!.text === text);
      expect(found, text).toBeDefined();
      // The probabilities beside each quoted message are the ones the run printed for that case, model by model.
      const numbers = (line: string) => [...line.matchAll(/\((\d\.\d\d)\)/g)].map((m) => m[1]);
      const row = readme.split("\n").find((line) => line.startsWith(`| "${text}" |`))!;
      expect(numbers(row), text).toEqual(numbers(run.find((line) => line.trimStart().startsWith(`${found!.id} `))!));
    }
  });
});
