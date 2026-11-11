/**
 * Assembles authenticated REST routes around an injected engine.
 * Request bodies are validated at the boundary; Workers imports must remain free of eager Node I/O.
 */
import { ConflictError, Engine, NotFoundError, ValidationError, type Actor, type Authorize } from "@verdict-ai/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { z } from "zod";
import { openapiFor } from "./openapi.js";
import { registerAdmin } from "./routes/admin.js";
import { registerBatches } from "./routes/batches.js";
import { registerEvaluations } from "./routes/evaluations.js";
import { registerPublications } from "./routes/publications.js";
import { publisherFor, PUBLIC_HUB_PATHS, registerHub } from "./routes/hub.js";
import { isPublicHubPath, registerPublicHub } from "./routes/public-hub.js";
import { defaultClientKey, defaultHubLimits, RateLimitedError, type ClientKey, type HubLimits } from "./rate-limit.js";
import type { GithubConfig } from "./github.js";
import { registerRubrics } from "./routes/rubrics.js";
import { registerProjects } from "./routes/projects.js";
import { registerProjectVersions } from "./routes/project-versions.js";
import { registerPromotions } from "./routes/promotions.js";
import { registerReports } from "./routes/reports.js";
import { ApiError } from "./routes/shared.js";

/** A request's account and who made it. `claims` reach `authorize` as they are (a role, what a key may reach). */
export interface Identity { tenantId: string; actor: Actor; claims?: Record<string, unknown> }

export interface Auth {
  /**
   * Map an API key to a tenant id — or to a tenant and who is asking — or undefined to reject. Return "" for
   * single-tenant open mode. A bare tenant id means an unnamed key made the request.
   *
   * `request` is the request being authenticated, for servers where the key alone does not settle the tenant: a
   * person who belongs to several organisations names one (`x-verdict-org`), and a browser sends a session cookie
   * and no key. Servers that map a key to one tenant ignore it.
   */
  resolve(apiKey: string | undefined, request?: Request): Promise<string | Identity | undefined> | string | Identity | undefined;
}

/** How this server signs people in from the CLI, when it runs the approval itself. */
export interface BrowserSignIn {
  kind: "browser";
  /** POST → `{ deviceCode, userCode, verificationUri, expiresIn, interval }`. Path on this server. */
  start: string;
  /** POST `{ deviceCode }` → `{ apiKey, keyId?, handle? }`, or an error of type `authorization_pending`, `slow_down`, `expired_token` or `access_denied`. */
  token: string;
}

/** Route groups an app can serve (docs/design/control-plane.md §9.2). Admin and discovery routes are always there. */
export const ROUTE_GROUPS = ["evaluations", "rubrics", "hub", "control"] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

/** Reads `VERDICT_ROUTES="hub,control"`; unset serves every group. Throws on a name that is not a group, at startup. */
export function routeGroups(value: string | undefined): readonly RouteGroup[] {
  if (!value?.trim()) return ROUTE_GROUPS;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(ROUTE_GROUPS as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`VERDICT_ROUTES: unknown route group ${unknown.join(", ")}; use ${ROUTE_GROUPS.join(", ")}`);
  return names as RouteGroup[];
}

/** `VERDICT_API_KEYS="key1:tenantA,key2:tenantB"`; a bare key maps to tenant "default". Unset = open (single tenant). */
export function envAuth(env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}): Auth {
  const raw = env.VERDICT_API_KEYS?.trim();
  if (!raw) return { resolve: () => "default" };
  const keys = new Map(raw.split(",").map((pair) => { const [k, t] = pair.trim().split(":"); return [k!, t ?? "default"] as const; }));
  return { resolve: (k) => (k ? keys.get(k) : undefined) };
}

/** Optional API-key management (backed by @verdict-ai/db's DrizzleAuth). Exposed under /v1/admin with VERDICT_ADMIN_KEY. */
export interface KeyManager {
  createKey(tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }>;
  revokeKey(id: string, tenantId?: string): Promise<boolean>;
  listKeys(tenantId: string): Promise<Array<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>>;
}

export interface AppOptions {
  engine: Engine;
  auth?: Auth;
  keys?: KeyManager;
  /** Bearer token for /v1/admin/* (default: env VERDICT_ADMIN_KEY). Unset = admin routes disabled. */
  adminKey?: string;
  /** Return 202 immediately and finish in the background when the client asks (`"async": true`). */
  background?: (promise: Promise<unknown>) => void;
  allowAsync?: boolean;
  log?: boolean;
  /** Public handle a tenant publishes under on the hub; undefined refuses publishing. Default: the tenant id. */
  publisherOf?: (tenantId: string | undefined) => Promise<string | undefined> | string | undefined;
  /** Clock for stored timestamps (tests). */
  now?: () => number;
  /** GitHub OAuth App for hub sign-in (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET). Unset: tenants publish under their id. */
  github?: GithubConfig;
  /** Limits on sign-in, publishing and public reads. Default: in-memory counters (`DEFAULT_HUB_RULES`); `{}` turns them off. */
  limits?: HubLimits;
  /** Who a request comes from, for per-client limits. Default: Cloudflare's `cf-connecting-ip`, else one shared bucket. */
  clientKey?: ClientKey;
  /** Which route groups to serve; a group left out answers 404. Default: all of `ROUTE_GROUPS`. */
  routes?: readonly RouteGroup[];
  /** Allows or refuses each control-plane request (`/v1/projects…`). Default: a valid key may do everything. */
  authorize?: Authorize;
  /** Announced in `/v1/hub/config` so `verdict login` follows it. The routes it names are the embedding server's own. */
  signIn?: BrowserSignIn;
}

export type Env = { Variables: { tenantId: string; actor: Actor; claims?: Record<string, unknown> } };

/** Builds the REST app around an engine; route failures are translated into HTTP error responses. */
export function createApp(options: AppOptions) {
  const { engine, auth = envAuth(), keys, adminKey = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_ADMIN_KEY, allowAsync = true, background, log = false, now, routes = ROUTE_GROUPS } = options;
  const app = new Hono<Env>();
  if (log) app.use(logger());
  app.use("*", cors({ exposeHeaders: ["Idempotency-Replayed", "ETag"] }));

  app.get("/", (c) => c.json({ name: "verdict", version: "0.1.0", docs: "/v1/openapi.json" }));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  const openapi = openapiFor(routes);
  app.get("/v1/openapi.json", (c) => c.json(openapi));

  // why: admin routes use their own credential and must be registered before tenant authentication.
  registerAdmin(app, { engine, keys, adminKey, allowAsync, background, now });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health" || c.req.path === "/v1/openapi.json" || c.req.path.startsWith("/v1/admin/") || PUBLIC_HUB_PATHS.has(c.req.path) || isPublicHubPath(c.req.path)) return next();
    const header = c.req.header("authorization");
    const key = header?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key");
    const who = await auth.resolve(key, c.req.raw);
    if (who === undefined) throw new HTTPException(401, { message: "invalid or missing API key" });
    const identity: Identity = typeof who === "string" ? { tenantId: who, actor: { kind: "key" } } : who;
    c.set("tenantId", identity.tenantId);
    c.set("actor", identity.actor);
    if (identity.claims) c.set("claims", identity.claims);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof RateLimitedError) { c.header("retry-after", "60"); return c.json({ error: { type: "rate_limited", message: err.message } }, 429); }
    if (err instanceof ApiError) return c.json({ error: { type: err.type, message: err.message, ...err.extra } }, err.status);
    if (err instanceof HTTPException) return c.json({ error: { type: "http", message: err.message } }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: { type: "validation", message: "invalid request", issues: err.issues } }, 400);
    if (err instanceof NotFoundError) return c.json({ error: { type: "not_found", message: err.message } }, 404);
    if (err instanceof ConflictError) return c.json({ error: { type: "idempotency_conflict", message: err.message } }, 409);
    if (err instanceof ValidationError) return c.json({ error: { type: "validation", message: err.message } }, 400);
    const message = (err as Error).message ?? "internal error";
    // why: legacy rubric validators still throw plain errors; preserve their established 400 responses.
    const status = /duplicate|unknown|requires|must/i.test(message) ? 400 : 500;
    return c.json({ error: { type: status === 400 ? "validation" : "internal", message } }, status);
  });

  registerGroups(app, { ...options, engine, keys, adminKey, allowAsync, background, routes });

  return app;
}

function registerGroups(app: Hono<Env>, options: AppOptions & { routes: readonly RouteGroup[] }) {
  const { engine, keys, adminKey, allowAsync, background, github, now, limits = defaultHubLimits(now), clientKey = defaultClientKey, publisherOf } = options;
  const on = (group: RouteGroup) => options.routes.includes(group);
  if (on("rubrics")) registerRubrics(app, { engine, keys, adminKey, allowAsync, background });
  if (on("evaluations")) {
    registerEvaluations(app, { engine, keys, adminKey, allowAsync, background });
    registerBatches(app, { engine, keys, adminKey, allowAsync, background });
  }
  if (on("hub")) {
    registerHub(app, { engine, keys, github, now, limits, clientKey, signIn: options.signIn });
    registerPublications(app, { engine, publisherOf: publisherOf ?? publisherFor({ engine, github }), now, limits });
    registerPublicHub(app, { engine, limits, clientKey });
  }
  if (on("control")) {
    registerProjects(app, options);
    registerProjectVersions(app, options);
    registerPromotions(app, options);
    registerReports(app, options);
  }
}

export { present } from "./present.js";
