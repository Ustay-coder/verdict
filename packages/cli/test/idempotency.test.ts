import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCli } from "../src/index.js";

it("replays local eval and compare commands with the supplied key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verdict-cli-idempotency-"));
  vi.stubEnv("VERDICT_DATA_DIR", dir);
  vi.stubEnv("VERDICT_API_URL", "");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = join(dir, "rubric.json");
    await writeFile(path, JSON.stringify({ name: "Retry", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] }));
    const run = (args: string[]) => buildCli().parseAsync(args, { from: "user" });
    const evalArgs = ["eval", "-r", path, "-i", "text:hello", "--idempotency-key", "eval"];
    await run([...evalArgs, "--json"]);
    const first = JSON.parse(String(log.mock.calls.at(-1)![0]));
    await run([...evalArgs, "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).id).toBe(first.id);
    await run(evalArgs);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/status:.*\(replayed\)/);
    const compareArgs = ["compare", "-r", path, "-s", "one=text:hello", "two=text:world", "--idempotency-key", "compare"];
    await run([...compareArgs, "--json"]);
    const ranking = JSON.parse(String(log.mock.calls.at(-1)![0]));
    await run([...compareArgs, "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual(ranking);
    await run(compareArgs);
    expect(String(log.mock.calls.at(-1)![0])).toContain("(replayed)");
  } finally {
    log.mockRestore(); vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
