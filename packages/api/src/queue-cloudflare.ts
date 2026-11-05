import type { Job, Queue } from "@verdict/core";

export class CloudflareQueue implements Queue {
  constructor(private binding: { send(body: Job, options?: { delaySeconds?: number }): Promise<unknown> }) {}
  async enqueue(job: Job, opts?: { delayMs?: number }): Promise<void> {
    await this.binding.send(job, { delaySeconds: Math.ceil((opts?.delayMs ?? 0) / 1000) });
  }
}
