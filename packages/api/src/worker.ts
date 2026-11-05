/**
 * Cloudflare Workers entry. wrangler.toml needs a D1 binding named DB (see wrangler.example.toml) and secrets:
 *   TYPESAFE_API_KEY / CLOUDFLARE_* for judges, VERDICT_API_KEYS (bootstrap keys), VERDICT_ADMIN_KEY (key management).
 * Apply migrations with: wrangler d1 migrations apply verdict --remote   (migrations_dir = packages/db/drizzle)
 * Without a DB binding the worker falls back to an in-memory store (per isolate — demo only).
 */
import { Engine, MemoryStore } from "@verdict/core";
import { fromD1 } from "@verdict/db";
import { createApp, envAuth } from "./app.js";

type Env = Record<string, string | undefined> & { DB?: D1Database };

export default {
  fetch(request: Request, env: Env) {
    const { DB, ...vars } = env;
    const envKeys = envAuth(vars);
    const d1 = DB ? fromD1(DB, vars.VERDICT_API_KEYS ? envKeys : undefined) : undefined;
    const engine = new Engine({ store: d1?.store ?? new MemoryStore(), env: (n) => vars[n], webhookSecret: vars.VERDICT_WEBHOOK_SECRET });
    const app = createApp({ engine, auth: d1?.auth ?? envKeys, keys: d1?.auth, adminKey: vars.VERDICT_ADMIN_KEY, allowAsync: false });
    return app.fetch(request);
  },
};
