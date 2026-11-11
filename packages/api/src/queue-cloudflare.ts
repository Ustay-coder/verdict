/**
 * Adapts serializable engine jobs to a Cloudflare queue binding.
 * Messages carry request data only; the consumer owns execution and retry policy.
 */
import type { Job, Queue } from "@verdict-ai/core";

/** Sends jobs to the queue binding; enqueue rejects when the binding cannot accept a message. */
export class CloudflareQueue implements Queue {
  constructor(private binding: { send(body: Job, options?: { delaySeconds?: number }): Promise<unknown> }) {}
  async enqueue(job: Job, opts?: { delayMs?: number }): Promise<void> {
    await this.binding.send(job, { delaySeconds: Math.ceil((opts?.delayMs ?? 0) / 1000) });
  }
}
