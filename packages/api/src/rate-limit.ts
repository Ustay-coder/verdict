/**
 * Request limits for the hub's open doors (docs/design/hub.md H6): sign-in, publishing, and public reads. A limiter
 * answers whether one more request under a key is allowed. The in-memory limiter counts per process (per isolate on
 * Workers) and is a floor; on Cloudflare, bind the Workers Rate Limiting API to share counts across isolates.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export interface RateLimiter { limit(key: string): Promise<boolean> | boolean }

/** `login`: per client address. `publish` (preview included): per account. `read`: public JSON and pages, per client address. */
export interface HubLimits { login?: RateLimiter; publish?: RateLimiter; read?: RateLimiter }

export interface Rule { limit: number; windowMs: number }
export const DEFAULT_HUB_RULES: Record<keyof HubLimits, Rule> = {
  login: { limit: 10, windowMs: 60_000 },
  publish: { limit: 30, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 },
};

/** Fixed-window counter. Old windows are dropped as the map grows, so memory stays bounded by active keys. */
export function memoryLimiter({ limit, windowMs }: Rule, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    limit(key) {
      const t = now();
      if (windows.size > 10_000) for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) { windows.set(key, { start: t, count: 1 }); return true; }
      w.count++;
      return w.count <= limit;
    },
  };
}

export function defaultHubLimits(now?: () => number): Required<HubLimits> {
  return { login: memoryLimiter(DEFAULT_HUB_RULES.login, now), publish: memoryLimiter(DEFAULT_HUB_RULES.publish, now), read: memoryLimiter(DEFAULT_HUB_RULES.read, now) };
}

/** Cloudflare's Workers Rate Limiting binding (`[[ratelimits]]` in wrangler.toml). */
export interface CloudflareRateLimit { limit(options: { key: string }): Promise<{ success: boolean }> }

export const cloudflareLimiter = (binding: CloudflareRateLimit): RateLimiter => ({ limit: async (key) => (await binding.limit({ key })).success });

/**
 * The client a request comes from. Only a header the platform sets is trusted (Cloudflare's `cf-connecting-ip`), or the
 * socket address the Node server passes in; X-Forwarded-For is anyone's to write.
 */
export type ClientKey = (c: Context) => string;
export const defaultClientKey: ClientKey = (c) => c.req.header("cf-connecting-ip") ?? "anonymous";

/** Answered as 429 with Retry-After by the app's error handler. */
export class RateLimitedError extends HTTPException {
  constructor(what: string) { super(429, { message: `too many ${what} requests; try again in a minute` }); }
}

export async function enforce(limiter: RateLimiter | undefined, key: string, what: string): Promise<void> {
  if (limiter && !(await limiter.limit(key))) throw new RateLimitedError(what);
}
