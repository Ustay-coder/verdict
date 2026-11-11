import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "@verdict-ai/core";
import { createApp } from "@verdict-ai/api";
import { buildCli } from "../src/index.js";

vi.mock("@verdict-ai/api/server", () => ({ startServer: vi.fn() }));
vi.mock("@verdict-ai/mcp", () => ({ createMcpServer: () => ({ connect: vi.fn() }) }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); process.exitCode = 0; });

it("runs remote commands against the API with the same reporting and replay behavior", async () => {
  const engine = new Engine(); const app = createApp({ engine });
  vi.stubEnv("VERDICT_API_URL", "https://verdict.test");
  vi.stubEnv("VERDICT_API_KEY", "key");
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => app.request(String(url), init));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = (...args: string[]) => buildCli().parseAsync(args, { from: "user" });
  const last = () => String(log.mock.calls.at(-1)![0]);
  const rubric = await engine.createRubric({ name: "Remote", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "auto", name: "Auto" }, { id: "human", name: "Human", judge: { type: "human" } }] });
  // API open mode scopes reads to its default tenant.
  rubric.tenantId = "default";
  await run("rubric", "list"); expect(last()).toContain(rubric.id);
  await run("eval", "-r", rubric.id, "-i", "text:hello", "--json");
  const ev = JSON.parse(last()); expect(ev.status).toBe("pending_human");
  await run("eval", "-r", rubric.id, "-i", "text:hello", "--idempotency-key", "eval");
  await run("eval", "-r", rubric.id, "-i", "text:hello", "--idempotency-key", "eval");
  expect(last()).toContain("replayed");
  await run("tasks"); expect(last()).toContain("human");
  await run("get", ev.id); expect(last()).toContain("Remote");
  await run("score", ev.id, "human", "--rater", "bob", "--score", "pass"); expect(last()).toContain("completed");
  await run("reaggregate", ev.id, "--method", "max"); expect(last()).toContain("score:");
  await run("calibrate", rubric.id, "--json"); expect(JSON.parse(last()).overall.n).toBe(0);
  await run("compare", "-r", rubric.id, "-s", "a=text:one", "b=text:two", "--json"); expect(JSON.parse(last())).toHaveLength(2);
  await run("compare", "-r", rubric.id, "-s", "a=text:one", "b=text:two", "--idempotency-key", "batch");
  await run("compare", "-r", rubric.id, "-s", "a=text:one", "b=text:two", "--idempotency-key", "batch"); expect(last()).toContain("replayed");
});

it("registers hosting commands and manages local database keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verdict-keys-"));
  vi.stubEnv("VERDICT_API_URL", "");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = (...args: string[]) => buildCli().parseAsync(args, { from: "user" });
  try {
    await run("serve", "--port", "9876", "--data-dir", dir);
    const { startServer } = await import("@verdict-ai/api/server");
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ port: 9876, dataDir: dir }));
    await run("mcp");
    const database = join(dir, "keys.sqlite");
    await run("keys", "create", "--database", database, "--tenant", "a", "--name", "Test");
    const id = /\(id ([^;]+)/.exec(String(log.mock.calls.at(-1)![0]))![1]!;
    await run("keys", "list", "--database", database, "--tenant", "a");
    expect(String(log.mock.calls.at(-1)![0])).toContain("active");
    await run("keys", "revoke", id, "--database", database); expect(String(log.mock.calls.at(-1)![0])).toBe("revoked");
    await run("keys", "list", "--database", database, "--tenant", "a"); expect(String(log.mock.calls.at(-1)![0])).toContain("revoked");
    await run("keys", "revoke", "missing", "--database", database); expect(String(log.mock.calls.at(-1)![0])).toBe("not found");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
