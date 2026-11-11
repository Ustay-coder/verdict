import { expect, it, vi } from "vitest";
import { Engine, MemoryStore, RetryableError, type Job } from "@verdict-ai/core";
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

it("sends evidence images through the Workers AI binding and enforces Clef's limits", async () => {
  const { aiBindingProvider } = await import("../src/worker.js");
  const run = vi.fn().mockResolvedValue({ answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 0 } });
  const provider = aiBindingProvider({ run } as never);
  expect(provider).toMatchObject({ acceptsImages: true, maxImages: 4 });
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const questions = { a: { type: "noul" as const, instructions: "ok?" } };
  await provider.decide({ state: "s", questions, images: [image], options: { request: { images: [image] } } }, {} as never);
  expect(run.mock.calls[0]![1]).toMatchObject({ model: "clef-flash", images: [image, image] });
  await expect(provider.decide({ state: "s", questions, images: ["https://example.com/a.png"] }, {} as never)).rejects.toThrow(/data URI/);
});
