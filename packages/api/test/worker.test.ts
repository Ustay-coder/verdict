import { expect, it, vi } from "vitest";
import { Engine, MemoryStore, RetryableError, type Job } from "@verdict/core";
import { createQueueHandler } from "../src/worker.js";

it("acks successful jobs and retries transient failures with rounded delay", async () => {
  const jobs: Job[] = [];
  const engine = new Engine({ store: new MemoryStore(), queue: { enqueue: async job => { jobs.push(job); } } });
  await engine.enqueueEvaluation({ rubric: { name: "Mock", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] }, subject: { inputs: [{ type: "text", text: "hello" }] } });
  const handler = createQueueHandler(() => ({ engine, auth: { resolve: () => "default" }, keys: undefined, adminKey: undefined }));
  const message = { body: jobs[0]!, ack: vi.fn(), retry: vi.fn() };
  await handler({ messages: [message] }, {});
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
  vi.spyOn(engine, "processJob").mockRejectedValue(new RetryableError("429", 1001));
  await handler({ messages: [message] }, {});
  expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
});
