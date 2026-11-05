import { Engine, MemoryStore, RetryableError, registerDecisionProvider, type DecisionProviderAdapter, type Job, type SystemOneAnswer } from "@verdict/core";
import { fromD1 } from "@verdict/db";
import { createApp, envAuth } from "./app.js";
import { CloudflareQueue } from "./queue-cloudflare.js";

export interface Env {
  [name: string]: unknown;
  DB?: D1Database;
  QUEUE?: { send(body: Job, options?: { delaySeconds?: number }): Promise<unknown> };
  /** Workers AI binding: Clef / Clef-flash run in-network without a REST token. */
  AI?: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
}
const memory = new MemoryStore();

/**
 * Decision provider "cloudflare" backed by the Workers AI binding instead of the REST API.
 * Same System One body (`model` selector, `state`, `questions`); the binding returns the inner result directly.
 */
function aiBindingProvider(ai: NonNullable<Env["AI"]>): DecisionProviderAdapter {
  return {
    name: "cloudflare",
    async decide(req) {
      const model = req.model ?? "@cf/cloudflare/clef-flash";
      const extra = req.options?.request;
      const body = { model: (req.options?.selector as string | undefined) ?? model.split("/").pop(), state: req.state, questions: req.questions, ...(extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {}) };
      const data = (await ai.run(model, body)) as { answers?: Record<string, SystemOneAnswer>; model?: string; usage?: { input_tokens?: number; prompt_tokens?: number; output_tokens?: number } };
      return { answers: data.answers ?? {}, model, usage: { inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }, raw: data };
    },
  };
}

/** Shared by HTTP producers and queue consumers. */
export function buildEngine(env: Env) {
  const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const envKeys = envAuth(vars);
  const d1 = env.DB ? fromD1(env.DB, vars.VERDICT_API_KEYS ? envKeys : undefined) : undefined;
  if (env.AI) registerDecisionProvider(aiBindingProvider(env.AI));
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
