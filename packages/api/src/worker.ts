/**
 * Cloudflare Workers entry. Deploy with wrangler:
 *   main = "packages/api/dist/worker.js"; set ANTHROPIC_API_KEY / VERDICT_API_KEYS as secrets.
 * Swap MemoryStore for a D1/KV-backed Store implementation for persistence.
 */
import { Engine, MemoryStore } from "@verdict/core";
import { createApp, envAuth } from "./app.js";

let cached: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Record<string, string | undefined>) {
    cached ??= createApp({ engine: new Engine({ store: new MemoryStore(), env: (n) => env[n] }), auth: envAuth(env), allowAsync: false });
    return cached.fetch(request);
  },
};
