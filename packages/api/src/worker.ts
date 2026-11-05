import { Engine, MemoryStore, RetryableError, type Job } from "@verdict/core";
import { fromD1 } from "@verdict/db";
import { createApp, envAuth } from "./app.js";
import { CloudflareQueue } from "./queue-cloudflare.js";

export interface Env {
  [name: string]: unknown;
  DB?: D1Database;
  QUEUE?: { send(body: Job, options?: { delaySeconds?: number }): Promise<unknown> };
}
const memory = new MemoryStore();

/** Shared by HTTP producers and queue consumers. */
export function buildEngine(env: Env) {
  const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const envKeys = envAuth(vars);
  const d1 = env.DB ? fromD1(env.DB, vars.VERDICT_API_KEYS ? envKeys : undefined) : undefined;
  const engine = new Engine({ store: d1?.store ?? memory, queue: env.QUEUE ? new CloudflareQueue(env.QUEUE) : undefined, env: n => vars[n], webhookSecret: vars.VERDICT_WEBHOOK_SECRET });
  return { engine, auth: d1?.auth ?? envKeys, keys: d1?.auth, adminKey: vars.VERDICT_ADMIN_KEY };
}

export interface JobMessage {
  body: Job;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}
export function createQueueHandler(build = buildEngine) {
  return async (batch: { messages: readonly JobMessage[] }, env: Env, _ctx?: unknown) => {
    const { engine } = build(env);
    await Promise.all(batch.messages.map(async message => {
      try { await engine.processJob(message.body); message.ack(); }
      catch (error) {
        if (error instanceof RetryableError) message.retry({ delaySeconds: Math.ceil((error.retryAfterMs ?? 0) / 1000) });
        else message.ack();
      }
    }));
  };
}
export const queue = createQueueHandler();
export default {
  fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    const app = createApp({ ...buildEngine(env), background: promise => ctx.waitUntil(promise) });
    return app.fetch(request);
  },
  queue,
};
