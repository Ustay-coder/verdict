import { expect, it, vi } from "vitest";
import { Command } from "commander";
import { Engine, parseRubric } from "@verdict-ai/core";
import { registerEvaluate } from "../src/commands/evaluate.js";
import { parseInput } from "../src/inputs.js";

it("runs evaluate in process with injected engine and output", async () => {
  const stdout = vi.fn();
  const setExitCode = vi.fn();
  const engine = new Engine();
  const rubric = parseRubric({ name: "Test", criteria: [{ id: "a", name: "A", judge: { type: "benchmark", method: "regex", pattern: "hello" } }] });
  const program = new Command();
  registerEvaluate(program, {
    loadRubric: async () => rubric, parseInput, readStdin: async () => "hello",
    remote: () => undefined, localEngine: () => engine, stdout, setExitCode,
  });
  await program.parseAsync(["evaluate", "-r", "virtual", "-i", "text:hello", "--json"], { from: "user" });
  expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ status: "completed", aggregate: { score: 100 } });
  expect(setExitCode).not.toHaveBeenCalled();
});

it("treats image paths as image inputs and adds screenshots to URL inputs with --screenshot", async () => {
  expect(parseInput("shot=ui/home.PNG")).toMatchObject({ type: "image", filename: "home.PNG", label: "shot", tags: ["shot"] });
  expect(parseInput("notes.md")).toMatchObject({ type: "file" });
  const engine = new Engine({ fetch: (async () => new Response("<html><title>t</title>hello</html>", { headers: { "content-type": "text/html" } })) as typeof fetch });
  const stdout = vi.fn();
  const rubric = parseRubric({ name: "Test", criteria: [{ id: "a", name: "A", judge: { type: "benchmark", method: "regex", pattern: "hello" } }] });
  const program = new Command();
  registerEvaluate(program, { loadRubric: async () => rubric, parseInput, readStdin: async () => "", remote: () => undefined, localEngine: () => engine, stdout, setExitCode: vi.fn() });
  await program.parseAsync(["evaluate", "-r", "virtual", "-i", "https://example.com/", "--screenshot", "--json", "--evidence"], { from: "user" });
  const ev = JSON.parse(stdout.mock.calls[0]![0]);
  expect(ev.subject.inputs[0]).toMatchObject({ type: "url", screenshot: true });
  // This engine has no renderer: the page text is kept and the missing screenshot is reported, not fatal.
  expect(ev.evidence[0].warnings[0]).toMatch(/no screenshot renderer/);
  expect(ev.aggregate.score).toBe(100);
});
