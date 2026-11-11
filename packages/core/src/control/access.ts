/**
 * The one place a control-plane request is allowed or refused (docs/design/control-plane.md §9.1). Open-source
 * servers allow everything; a hosted build plugs in roles, plan limits and approvals without touching the routes.
 */
import type { Actor } from "./types.js";

/** What a control-plane request does. A promotion request asks once per rubric it changes. */
export const CONTROL_ACTIONS = [
  "project.create", "project.read", "project.delete",
  "environment.create", "environment.read", "environment.delete",
  "version.put", "version.read", "version.delete",
  "pointer.promote", "pointer.rollback", "pointer.unset",
  "history.read", "report.put", "report.read",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Who is asking: the account the request belongs to (none on an open single-tenant server) and who made it. */
export interface Principal {
  tenantId?: string;
  actor: Actor;
  /** Whatever signing in established about the caller — a role, what a key may reach — handed over untouched. */
  claims?: Record<string, unknown>;
}

/** What the action is about, as far as the request says. */
export interface AccessTarget { project?: string; environment?: string; name?: string; versionId?: string | null }

export interface AccessRequest { principal: Principal; action: ControlAction; target: AccessTarget }

/** Why a request was refused. Clients pick their wording from this value, so it is a fixed list. */
export const ACCESS_REFUSALS = ["forbidden", "limit_exceeded", "approval_required"] as const;
export type AccessRefusal = (typeof ACCESS_REFUSALS)[number];

/** A refusal may carry `details` — which limit, how much of it is used — which reach the client in the error object. */
export type AccessDecision = { allow: true } | { allow: false; reason: AccessRefusal; message?: string; details?: Record<string, unknown> };

export type Authorize = (request: AccessRequest) => AccessDecision | Promise<AccessDecision>;

/** The open-source default: a valid key may do everything. */
export const allowAll: Authorize = () => ({ allow: true });
