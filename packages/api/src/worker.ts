/**
 * Builds Workers-compatible engines and consumes Cloudflare queue messages.
 * D1 reservations commit before judging; failed queue attempts must be acknowledged or retried explicitly.
 */
import { CLEF_LIMITS, Engine, MemoryStore, RetryableError, checkClefImages, registerDecisionProvider, type DecisionProviderAdapter, type Job, type SystemOneAnswer } from "@verdict-ai/core";
import { fromD1 } from "@verdict-ai/db";
import { createApp, envAuth, routeGroups } from "./app.js";
import { CloudflareQueue } from "./queue-cloudflare.js";
import { cloudflareLimiter, defaultHubLimits, type CloudflareRateLimit, type HubLimits } from "./rate-limit.js";

export interface Env {
  [name: string]: unknown;
  DB?: D1Database;
  QUEUE?: Pick<Queue<Job>, "send">;
  /** Workers AI binding: Clef / Clef-flash run in-network without a REST token. */
  AI?: Pick<Ai, "run">;
  /** Workers Rate Limiting bindings for the hub; without them, counts are kept per isolate. */
  HUB_LOGIN_LIMITER?: CloudflareRateLimit;
  HUB_PUBLISH_LIMITER?: CloudflareRateLimit;
  HUB_READ_LIMITER?: CloudflareRateLimit;
}
const memory = new MemoryStore();
// An app is built per request; the fallback counters must outlive it to count anything.
const isolateLimits = defaultHubLimits();

/** Hub limits: a Cloudflare binding where configured, else this isolate's counters. */
export function hubLimits(env: Env): HubLimits {
  return {
    login: env.HUB_LOGIN_LIMITER ? cloudflareLimiter(env.HUB_LOGIN_LIMITER) : isolateLimits.login,
    publish: env.HUB_PUBLISH_LIMITER ? cloudflareLimiter(env.HUB_PUBLISH_LIMITER) : isolateLimits.publish,
    read: env.HUB_READ_LIMITER ? cloudflareLimiter(env.HUB_READ_LIMITER) : isolateLimits.read,
  };
}

/**
 * Decision provider "cloudflare" backed by the Workers AI binding instead of the REST API.
 * Same System One body (`model` selector, `state`, `questions`); the binding returns the inner result directly.
 */
export function aiBindingProvider(ai: NonNullable<Env["AI"]>): DecisionProviderAdapter {
  return {
    name: "cloudflare",
    acceptsImages: true,
    maxImages: CLEF_LIMITS.maxImages,
    async decide(req) {
      const model = req.model ?? "@cf/cloudflare/clef-flash";
      const extra = req.options?.request;
      const extras: Record<string, unknown> = extra && typeof extra === "object" && !Array.isArray(extra) ? { ...extra } : {};
      // Same image rules as the REST adapter: rubric-supplied images first, then the evidence's own.
      const images = [...(Array.isArray(extras.images) ? extras.images.filter((x): x is string => typeof x === "string") : []), ...(req.images ?? [])];
      checkClefImages(images);
      const body = { model: (req.options?.selector as string | undefined) ?? model.split("/").pop(), state: req.state, questions: req.questions, ...extras, ...(images.length ? { images } : {}) };
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
  const github = vars.GITHUB_CLIENT_ID ? { clientId: vars.GITHUB_CLIENT_ID, clientSecret: vars.GITHUB_CLIENT_SECRET } : undefined;
  return { engine, auth: d1?.auth ?? envKeys, keys: d1?.auth, adminKey: vars.VERDICT_ADMIN_KEY, github, limits: hubLimits(env), routes: routeGroups(vars.VERDICT_ROUTES) };
}

export interface JobMessage {
  body: Job;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}
/** Returns a queue consumer; retryable jobs retry and terminal jobs are acknowledged. */
export function createQueueHandler(build = buildEngine) {
  return async (batch: Pick<MessageBatch<Job>, "messages"> | { messages: readonly JobMessage[] }, env: Env, _ctx?: ExecutionContext) => {
    const { engine } = build(env);
    await Promise.all(batch.messages.map(async message => {
      try { await engine.processJob(message.body); message.ack(); }
      catch (error) {
        if (error instanceof RetryableError) message.retry({ delaySeconds: Math.ceil((error.retryAfterMs ?? 0) / 1000) });
        // why: permanent failures must not poison the queue through endless redelivery.
        else message.ack();
      }
    }));
  };
}
export const queue = createQueueHandler();
export default {
  fetch(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
    const app = createApp({ ...buildEngine(env), background: promise => ctx.waitUntil(promise) });
    return app.fetch(request);
  },
  queue,
};
