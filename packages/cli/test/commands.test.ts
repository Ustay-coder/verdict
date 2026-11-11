import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCli, parseInput } from "../src/index.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });

it("drives the local rubric, judging and human review lifecycle in process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verdict-commands-"));
  vi.stubEnv("VERDICT_DATA_DIR", join(dir, "data"));
  vi.stubEnv("VERDICT_API_URL", "");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  const run = (...args: string[]) => buildCli().parseAsync(args, { from: "user" });
  const last = () => String(log.mock.calls.at(-1)![0]);
  try {
    const starter = join(dir, "starter.yaml");
    await run("rubric", "init", starter);
    expect(await readFile(starter, "utf8")).toContain("Startup pitch review");
    await run("rubric", "validate", starter);
    expect(last()).toContain("OK:");
    const rubric = join(dir, "rubric.json");
    await writeFile(rubric, JSON.stringify({ name: "Review", defaultJudge: { type: "decision", provider: "typesafe" }, criteria: [
      { id: "automatic", name: "Automatic", anchors: { "0": "none", "10": "complete" } },
      { id: "human", name: "Human", judge: { type: "human", raters: ["alice"] } },
    ] }));
    await run("rubric", "push", rubric);
    const rubricId = last();
    await run("rubric", "list"); expect(last()).toContain(rubricId);
    await run("eval", "-r", rubric, "-i", "notes=text:hello", "data=json:{\"n\":1}", "--mock", "--json", "--evidence", "-n", "Subject");
    const evaluation = JSON.parse(last());
    expect(evaluation.status).toBe("pending_human");
    expect(evaluation.evidence[0].text).toContain("hello");
    await run("tasks", "--rater", "alice"); expect(last()).toContain(evaluation.id);
    await run("get", evaluation.id, "--json"); expect(JSON.parse(last()).id).toBe(evaluation.id);
    await run("score", evaluation.id, "human", "--rater", "alice", "--score", "8", "--rationale", "reviewed");
    expect(last()).toContain("status: completed");
    await run("get", evaluation.id); expect(last()).toContain("reviewed");
    await run("reaggregate", evaluation.id, "--method", "min", "--normalize", "0,10", "--pass", "1", "--persist");
    expect(last()).toContain("PASS");
    await run("reaggregate", evaluation.id, "--formula", "human_n");
    expect(last()).toContain("score:");
    await run("export", evaluation.id); expect(last()).toContain("Review");
    await run("tasks"); expect(last()).toBe("no pending human tasks");
    await run("calibrate", rubricId, "--json"); expect(JSON.parse(last()).overall.n).toBe(0);
    await run("calibrate", rubricId);
    await run("compare", "-r", rubric, "-s", "one=text:first", "two=text:second", "--mock", "--json");
    expect(JSON.parse(last())).toHaveLength(2);
    await run("compare", "-r", rubric, "-s", "one=text:first", "two=text:second", "--mock");
    expect(last()).toContain("pending_human");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("parses every input form without losing labels", () => {
  expect(parseInput("tag=text:a")).toMatchObject({ type: "text", label: "tag", tags: ["tag"], text: "a" });
  expect(parseInput("json:{\"a\":1}")).toMatchObject({ type: "json", data: { a: 1 } });
  expect(parseInput("https://example.com")).toMatchObject({ type: "url" });
  expect(parseInput("https://youtu.be/abcdefghijk")).toMatchObject({ type: "youtube" });
  expect(parseInput("-")).toMatchObject({ type: "text", label: "stdin" });
  expect(parseInput("tag=-")).toMatchObject({ label: "tag" });
  expect(parseInput("file.txt")).toMatchObject({ type: "file", filename: "file.txt" });
});
