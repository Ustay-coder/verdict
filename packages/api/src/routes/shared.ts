/**
 * Defines shared request handling at the REST boundary.
 * Tenant context flows to every engine/store operation; validation failures use the shared HTTP error mapper.
 */
import { allowAll, hasControl, loadRubricText, type AccessTarget, type ControlAction, type ControlStore, type ProjectScope } from "@verdict-ai/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";

/** A refusal clients can tell apart by `type`; `extra` is merged into the error object of the response. */
export class ApiError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly type: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** Reads a JSON body of at most `maxBytes`; 413 when larger, 400 when it is not JSON. An empty body reads as `{}`. */
export async function readJson(req: Request, maxBytes = 100_000): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HTTPException(413, { message: `the request may be at most ${maxBytes} bytes` });
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new HTTPException(400, { message: "the request body must be JSON" }); }
}

/** Decodes JSON or YAML rubric bodies; rejects read, syntax and rubric validation failures. */
export async function readRubricBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (ct.includes("yaml") || ct.includes("text/plain")) return loadRubricText(text);
  return JSON.parse(text);
}

/** Returns an optional idempotency key; throws ZodError when its length is outside 1–255 characters. */
export function readIdempotencyKey(req: Request): string | undefined {
  const key = req.headers.get("Idempotency-Key");
  return key === null ? undefined : z.string().min(1).max(255).parse(key);
}

/** Returns the authenticated tenant, or undefined for open local deployments. */
export const tenant = (c: { get(k: "tenantId"): string }) => c.get("tenantId") || undefined;

/** Documents leave without the tenant they are stored under. */
export function bare<T extends { tenantId?: string }>(doc: T): Omit<T, "tenantId"> {
  const { tenantId: _tenantId, ...rest } = doc;
  return rest;
}

const REFUSAL_MESSAGES = {
  forbidden: "this key is not allowed to do that",
  limit_exceeded: "this account's plan does not allow that",
  approval_required: "this change needs an approval first",
} as const;

/** What a refusal adds to the error object. It never replaces what says which refusal this is. */
function refusalDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  const { type: _type, message: _message, ...rest } = details;
  return rest;
}

/**
 * What every control-plane route works with: the store, the project a request is about, and `allow`, the one place a
 * request is allowed or refused (docs/design/control-plane.md §9.1). Routes call `allow` before they read or write.
 */
export function controlContext({ engine, authorize = allowAll, now = () => Date.now() }: AppOptions) {
  const store = (): ControlStore => {
    if (!hasControl(engine.store)) throw new HTTPException(501, { message: "this server's store cannot keep projects" });
    return engine.store.control;
  };
  const scope = (c: Context<Env>): ProjectScope => {
    const tenantId = tenant(c), project = c.req.param("project") ?? "";
    return tenantId === undefined ? { project } : { tenantId, project };
  };
  const allow = async (c: Context<Env>, action: ControlAction, target: AccessTarget = {}) => {
    const claims = c.get("claims");
    const decision = await authorize({ principal: { tenantId: tenant(c), actor: c.get("actor"), ...(claims ? { claims } : {}) }, action, target });
    if (!decision.allow) throw new ApiError(403, decision.reason, decision.message ?? REFUSAL_MESSAGES[decision.reason], refusalDetails(decision.details));
  };
  /** 404 unless the project of the request exists. */
  const project = async (c: Context<Env>): Promise<ProjectScope> => {
    const s = scope(c);
    if (!(await store().getProject(s.tenantId, s.project))) throw projectNotFound(s.project);
    return s;
  };
  return { store, scope, allow, project, at: () => new Date(now()).toISOString(), now };
}

export const projectNotFound = (name: string) => new ApiError(404, "not_found", `project ${name} not found`);
