/**
 * Persistence for the control plane. Every read and write is scoped to a tenant and a project: a missing tenant is
 * its own scope (the open single-tenant server), never a wildcard. Operations that must hold together — a pointer
 * change with its history, a version that may only be deleted while no pointer names it — are single calls so each
 * store can make them atomic in its own way.
 */
import { ValidationError } from "../engine/errors.js";
import type { ComparisonReport, Environment, Pointer, Project, ProjectScope, ProjectVersion, PromotionEvent, RubricName, RunReport } from "./types.js";

/** Why a set of pointer changes was not applied. Nothing is applied unless all of it can be. */
export type PromotionRefusal = "no_environment" | "unknown_version" | "conflict";

export interface HistoryQuery { environment?: string; name?: string; limit?: number }
export interface RunReportQuery { name?: string; versionId?: string; datasetName?: string; limit?: number }
export interface ComparisonReportQuery { name?: string; headVersionId?: string; limit?: number }

export interface ControlStore {
  /** False when the project already exists. */
  createProject(p: Project): Promise<boolean>;
  getProject(tenantId: string | undefined, name: string): Promise<Project | undefined>;
  /** Oldest first. */
  listProjects(tenantId: string | undefined): Promise<Project[]>;
  /** Removes the project and everything in it; false when it does not exist. */
  deleteProject(tenantId: string | undefined, name: string): Promise<boolean>;

  createEnvironment(e: Environment): Promise<"created" | "exists" | "no_project">;
  getEnvironment(scope: ProjectScope, name: string): Promise<Environment | undefined>;
  /** Oldest first. */
  listEnvironments(scope: ProjectScope): Promise<Environment[]>;
  /** Removes the environment and its pointers; its history stays in the project. False when it does not exist. */
  deleteEnvironment(scope: ProjectScope, name: string): Promise<boolean>;

  /** Stores a version unless it is already there; the stored one is returned either way. */
  putVersion(v: ProjectVersion): Promise<{ created: boolean; version: ProjectVersion } | "no_project">;
  getVersion(scope: ProjectScope, name: string, id: string): Promise<ProjectVersion | undefined>;
  /** Newest first; `name` narrows to one rubric. */
  listVersions(scope: ProjectScope, o?: { name?: string; limit?: number }): Promise<ProjectVersion[]>;
  /** The rubric names versions are kept under, by name. Complete: no limit applies. */
  listRubricNames(scope: ProjectScope): Promise<RubricName[]>;
  /** `in_use` while any environment's pointer names the version. */
  deleteVersion(scope: ProjectScope, name: string, id: string): Promise<"deleted" | "not_found" | "in_use">;

  /** An environment's pointers, by rubric name. */
  listPointers(scope: ProjectScope, environment: string): Promise<Pointer[]>;
  /**
   * Applies pointer changes of one environment, all or none. Each event applies only if the pointer is at `from`
   * and, unless it removes the pointer, `to` is a version kept under that name. On success the events are the history.
   */
  applyPromotions(events: PromotionEvent[]): Promise<{ ok: true } | { ok: false; reason: PromotionRefusal }>;
  /** Newest first. */
  listHistory(scope: ProjectScope, q?: HistoryQuery): Promise<PromotionEvent[]>;

  /** Stores a run's report unless that run was already reported; the stored one is returned either way. */
  putRunReport(r: RunReport): Promise<{ created: boolean; report: RunReport } | "no_project">;
  getRunReport(scope: ProjectScope, runId: string): Promise<RunReport | undefined>;
  /** Newest run first. */
  listRunReports(scope: ProjectScope, q?: RunReportQuery): Promise<RunReport[]>;
  putComparisonReport(c: ComparisonReport): Promise<{ created: boolean; report: ComparisonReport } | "no_project">;
  /** Newest first. */
  listComparisonReports(scope: ProjectScope, q?: ComparisonReportQuery): Promise<ComparisonReport[]>;

  /**
   * Retention: drops history and reports older than `before` (an ISO timestamp). Versions and pointers are kept, and
   * so is the latest change of every pointer however old — a rollback reads it to know where to return to.
   */
  prune(tenantId: string | undefined, before: string): Promise<void>;

  /** Counts across all of a tenant's projects: what a hosted build checks plan limits and caps against. */
  usage(tenantId: string | undefined, since: string): Promise<ControlUsage>;
}

/** How much a tenant keeps. `reports` counts run and comparison reports received at or after `since`. */
export interface ControlUsage { projects: number; environments: number; versions: number; reports: number }

export const CONTROL_LIST_LIMIT = 100;
/** Pointer changes one request may carry: keeps the single guarded statement under D1's bound-parameter limit. */
export const CONTROL_MAX_CHANGES = 20;

/** Rejects a batch no store could apply as one unit: empty, too large, across environments, or naming a rubric twice. */
export function checkPromotionBatch(events: PromotionEvent[]): void {
  const [first] = events;
  if (!first) throw new ValidationError("a promotion needs at least one change");
  if (events.length > CONTROL_MAX_CHANGES) throw new ValidationError(`a promotion may change at most ${CONTROL_MAX_CHANGES} rubrics at once`);
  const sameTarget = (e: PromotionEvent) => (e.tenantId ?? "") === (first.tenantId ?? "") && e.project === first.project && e.environment === first.environment;
  if (!events.every(sameTarget)) throw new ValidationError("a promotion changes one environment of one project");
  if (new Set(events.map((e) => e.name)).size !== events.length) throw new ValidationError("a promotion may name each rubric once");
}

/** A store that keeps the control plane exposes it as `control`. */
export function hasControl(store: object): store is { control: ControlStore } {
  return typeof (store as { control?: Partial<ControlStore> }).control?.applyPromotions === "function";
}
