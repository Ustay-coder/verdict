import { expect, it, vi } from "vitest";
import { Command } from "commander";
import { Engine } from "@verdict-ai/core";
import { registerCompare } from "../src/commands/compare.js";
import { registerReaggregate } from "../src/commands/reaggregate.js";
import { registerRubric } from "../src/commands/rubric.js";
import { registerKeys } from "../src/commands/keys.js";

const rubric = { name: "injected", criteria: [{ id: "a", name: "A", judge: { type: "benchmark", method: "keywords", keywords: ["pass"] } }] };

it("runs compare, rubric and reaggregate through injected memory adapters", async () => {
  const engine = new Engine();
  const out = vi.fn(), fail = vi.fn();
  const deps = { engine: () => engine, remote: () => undefined, out, fail };
  const program = new Command();
  registerCompare(program, { ...deps, loadRubric: async () => rubric });
  registerReaggregate(program, deps);
  registerRubric(program, { ...deps, readText: async () => JSON.stringify(rubric), writeFile: vi.fn() });
  const run = (...args: string[]) => program.parseAsync(args, { from: "user" });
  await run("compare", "-r", "unused", "-s", "one=text:pass", "two=text:missing", "--json");
  expect(JSON.parse(out.mock.lastCall![0])[0].subject).toBe("one");
  const evaluation = (await engine.store.listEvaluations())[0]!;
  await run("reaggregate", evaluation.id, "--method", "min");
  expect(out.mock.lastCall![0]).toContain("score:");
  await run("rubric", "push", "unused.json");
  await run("rubric", "list");
  expect(out.mock.lastCall![0]).toContain("injected");
  await expect(run("compare", "-r", "unused", "-s", "malformed")).rejects.toThrow("name=input");
  expect(fail).not.toHaveBeenCalled();
});

it("closes the injected key connection even when the operation fails", async () => {
  const close = vi.fn(), out = vi.fn();
  const auth = { createKey: vi.fn().mockRejectedValue(new Error("offline")), listKeys: vi.fn(), revokeKey: vi.fn() };
  const program = new Command();
  registerKeys(program, { engine: () => new Engine(), remote: () => undefined, out, fail: vi.fn(), open: async () => ({ auth, close }) });
  await expect(program.parseAsync(["keys", "create", "--database", "unused", "--tenant", "tenant", "--name", "key"], { from: "user" })).rejects.toThrow("offline");
  expect(close).toHaveBeenCalledOnce();
  expect(out).not.toHaveBeenCalled();
});
