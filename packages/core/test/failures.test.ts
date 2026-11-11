import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, FileStore, MemoryQueue, type Job } from "../src/index.js";

it("distinguishes missing documents from corrupt JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verdict-corrupt-"));
  try {
    const store = new FileStore(dir);
    expect(await store.getEvaluation("absent")).toBeUndefined();
    await mkdir(join(dir, "evaluations"));
    await writeFile(join(dir, "evaluations", "bad.json"), "{");
    await expect(store.getEvaluation("bad")).rejects.toBeInstanceOf(SyntaxError);
    await expect(store.listEvaluations()).rejects.toBeInstanceOf(SyntaxError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(["network", "http"])("reports %s webhook failures without losing completed results", async failure => {
  const onEvent = vi.fn();
  const engine = new Engine({ onEvent, fetch: async () => {
    if (failure === "network") throw new Error("offline");
    return new Response("busy", { status: 503 });
  } });
  const result = await engine.evaluate({ rubric: { name: "Offline", criteria: [{ id: "a", name: "A", judge: { type: "benchmark", method: "regex", pattern: "hello" } }] }, subject: { inputs: [{ type: "text", text: "hello" }] }, webhook: "https://example.com/hook" });
  expect(result.status).toBe("completed");
  expect(onEvent).toHaveBeenCalledWith({ type: "webhook.failed", evaluationId: result.id, error: failure === "network" ? "offline" : "webhook returned HTTP 503" });
});

it("rejects unsupported jobs and routes queue failures to onError", async () => {
  const engine = new Engine();
  const job = { type: "unsupported", evaluationId: "x", request: {}, attempt: 1 } as unknown as Job;
  await expect(engine.processJob(job)).rejects.toThrow("unknown job type");
  const onError = vi.fn();
  const queue = new MemoryQueue({ onError }); queue.engine = engine;
  await queue.enqueue(job); await queue.drain();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("unknown job type") }));
});
