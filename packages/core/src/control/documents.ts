/**
 * The control plane on a plain document collection: one implementation of the rules for the in-memory and the file
 * store. Every mutation runs inside `exclusive`, checks everything first and writes afterwards, so a refused change
 * leaves nothing behind. Database stores implement `ControlStore` directly with their own atomic statements.
 */
import { fingerprint } from "../idempotency.js";
import { checkPromotionBatch, CONTROL_LIST_LIMIT, type ComparisonReportQuery, type ControlStore, type HistoryQuery, type PromotionRefusal, type RunReportQuery } from "./store.js";
import type { ComparisonReport, Environment, Pointer, Project, ProjectScope, ProjectVersion, PromotionEvent, RubricName, RunReport } from "./types.js";

/** The storage a document control store needs. Keys are opaque, file-name-safe strings. */
export interface ControlDocs {
  get<T>(kind: string, key: string): Promise<T | undefined>;
  put(kind: string, key: string, value: object): Promise<void>;
  remove(kind: string, key: string): Promise<void>;
  all<T>(kind: string): Promise<T[]>;
  /** Runs `work` while no other mutation of this store runs. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

const KINDS = {
  projects: "control-projects", environments: "control-environments", versions: "control-versions", pointers: "control-pointers",
  promotions: "control-promotions", runs: "control-run-reports", comparisons: "control-comparison-reports",
} as const;

// A missing tenant is the scope of the open single-tenant server, not a wildcard.
const tenantOf = (tenantId: string | undefined) => tenantId ?? "";
const inTenant = (x: { tenantId?: string }, tenantId: string | undefined) => tenantOf(x.tenantId) === tenantOf(tenantId);
const inScope = (x: ProjectScope, s: ProjectScope) => inTenant(x, s.tenantId) && x.project === s.project;
const newest = <T>(items: T[], when: (item: T) => string, limit = CONTROL_LIST_LIMIT) => [...items].sort((a, b) => when(b).localeCompare(when(a))).slice(0, limit);
const oldest = <T extends { createdAt: string; name: string }>(items: T[]) => [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));

const key = (...parts: Array<string | undefined>) => fingerprint(parts.map((p) => p ?? ""));
const keys = {
  project: (tenantId: string | undefined, name: string) => key(tenantId, name),
  environment: (e: ProjectScope & { name: string }) => key(e.tenantId, e.project, e.name),
  version: (v: ProjectScope & { name: string; id: string }) => key(v.tenantId, v.project, v.name, v.id),
  pointer: (p: ProjectScope & { environment: string; name: string }) => key(p.tenantId, p.project, p.environment, p.name),
  promotion: (e: PromotionEvent) => key(e.tenantId, e.project, e.id),
  run: (scope: ProjectScope, runId: string) => key(scope.tenantId, scope.project, runId),
  comparison: (c: ProjectScope & { id: string }) => key(c.tenantId, c.project, c.id),
};

export class DocumentControlStore implements ControlStore {
  constructor(private docs: ControlDocs) { }

  async createProject(p: Project) {
    return this.docs.exclusive(async () => {
      const id = await keys.project(p.tenantId, p.name);
      if (await this.docs.get(KINDS.projects, id)) return false;
      await this.docs.put(KINDS.projects, id, p);
      return true;
    });
  }
  async getProject(tenantId: string | undefined, name: string) { return this.docs.get<Project>(KINDS.projects, await keys.project(tenantId, name)); }
  async listProjects(tenantId: string | undefined) { return oldest((await this.docs.all<Project>(KINDS.projects)).filter((p) => inTenant(p, tenantId))); }
  async deleteProject(tenantId: string | undefined, name: string) {
    return this.docs.exclusive(async () => {
      if (!(await this.getProject(tenantId, name))) return false;
      const scope = { tenantId, project: name };
      await this.removeWhere<Environment>(KINDS.environments, (e) => inScope(e, scope), keys.environment);
      await this.removeWhere<ProjectVersion>(KINDS.versions, (v) => inScope(v, scope), keys.version);
      await this.removeWhere<Pointer>(KINDS.pointers, (p) => inScope(p, scope), keys.pointer);
      await this.removeWhere<PromotionEvent>(KINDS.promotions, (e) => inScope(e, scope), keys.promotion);
      await this.removeWhere<RunReport>(KINDS.runs, (r) => inScope(r, scope), (r) => keys.run(r, r.summary.runId));
      await this.removeWhere<ComparisonReport>(KINDS.comparisons, (c) => inScope(c, scope), keys.comparison);
      await this.docs.remove(KINDS.projects, await keys.project(tenantId, name));
      return true;
    });
  }

  async createEnvironment(e: Environment) {
    return this.docs.exclusive(async () => {
      if (!(await this.getProject(e.tenantId, e.project))) return "no_project" as const;
      if (await this.getEnvironment(e, e.name)) return "exists" as const;
      await this.docs.put(KINDS.environments, await keys.environment(e), e);
      return "created" as const;
    });
  }
  async getEnvironment(scope: ProjectScope, name: string) { return this.docs.get<Environment>(KINDS.environments, await keys.environment({ ...scope, name })); }
  async listEnvironments(scope: ProjectScope) { return oldest((await this.docs.all<Environment>(KINDS.environments)).filter((e) => inScope(e, scope))); }
  async deleteEnvironment(scope: ProjectScope, name: string) {
    return this.docs.exclusive(async () => {
      if (!(await this.getEnvironment(scope, name))) return false;
      await this.removeWhere<Pointer>(KINDS.pointers, (p) => inScope(p, scope) && p.environment === name, keys.pointer);
      await this.docs.remove(KINDS.environments, await keys.environment({ ...scope, name }));
      return true;
    });
  }

  async putVersion(v: ProjectVersion) {
    return this.docs.exclusive(async () => {
      if (!(await this.getProject(v.tenantId, v.project))) return "no_project" as const;
      const existing = await this.getVersion(v, v.name, v.id);
      if (existing) return { created: false, version: existing };
      await this.docs.put(KINDS.versions, await keys.version(v), v);
      return { created: true, version: v };
    });
  }
  async getVersion(scope: ProjectScope, name: string, id: string) { return this.docs.get<ProjectVersion>(KINDS.versions, await keys.version({ ...scope, name, id })); }
  async listVersions(scope: ProjectScope, o: { name?: string; limit?: number } = {}) {
    const versions = (await this.docs.all<ProjectVersion>(KINDS.versions)).filter((v) => inScope(v, scope) && (!o.name || v.name === o.name));
    return newest(versions, (v) => v.createdAt, o.limit);
  }
  async listRubricNames(scope: ProjectScope) {
    const names = new Map<string, RubricName>();
    for (const v of await this.docs.all<ProjectVersion>(KINDS.versions)) {
      if (!inScope(v, scope)) continue;
      const seen = names.get(v.name) ?? { name: v.name, versions: 0, updatedAt: v.createdAt };
      names.set(v.name, { name: v.name, versions: seen.versions + 1, updatedAt: v.createdAt > seen.updatedAt ? v.createdAt : seen.updatedAt });
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async deleteVersion(scope: ProjectScope, name: string, id: string) {
    return this.docs.exclusive(async () => {
      if (!(await this.getVersion(scope, name, id))) return "not_found" as const;
      const pointers = await this.docs.all<Pointer>(KINDS.pointers);
      if (pointers.some((p) => inScope(p, scope) && p.name === name && p.versionId === id)) return "in_use" as const;
      await this.docs.remove(KINDS.versions, await keys.version({ ...scope, name, id }));
      return "deleted" as const;
    });
  }

  async listPointers(scope: ProjectScope, environment: string) {
    const pointers = (await this.docs.all<Pointer>(KINDS.pointers)).filter((p) => inScope(p, scope) && p.environment === environment);
    return pointers.sort((a, b) => a.name.localeCompare(b.name));
  }
  async applyPromotions(events: PromotionEvent[]) {
    checkPromotionBatch(events);
    return this.docs.exclusive(async () => {
      const reason = await this.refusal(events);
      if (reason) return { ok: false as const, reason };
      for (const e of events) {
        await this.docs.put(KINDS.promotions, await keys.promotion(e), e);
        if (e.to === null) await this.docs.remove(KINDS.pointers, await keys.pointer(e));
        else await this.docs.put(KINDS.pointers, await keys.pointer(e), pointerOf(e, e.to));
      }
      return { ok: true as const };
    });
  }
  async listHistory(scope: ProjectScope, q: HistoryQuery = {}) {
    const events = (await this.docs.all<PromotionEvent>(KINDS.promotions)).filter((e) => inScope(e, scope) && (!q.environment || e.environment === q.environment) && (!q.name || e.name === q.name));
    return [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, q.limit ?? CONTROL_LIST_LIMIT);
  }

  async putRunReport(r: RunReport) {
    return this.docs.exclusive(async () => {
      if (!(await this.getProject(r.tenantId, r.project))) return "no_project" as const;
      const existing = await this.getRunReport(r, r.summary.runId);
      if (existing) return { created: false, report: existing };
      await this.docs.put(KINDS.runs, await keys.run(r, r.summary.runId), r);
      return { created: true, report: r };
    });
  }
  async getRunReport(scope: ProjectScope, runId: string) { return this.docs.get<RunReport>(KINDS.runs, await keys.run(scope, runId)); }
  async listRunReports(scope: ProjectScope, q: RunReportQuery = {}) {
    const matches = (r: RunReport) => (!q.name || r.name === q.name) && (!q.versionId || r.summary.rubricVersionId === q.versionId) && (!q.datasetName || r.datasetName === q.datasetName);
    return newest((await this.docs.all<RunReport>(KINDS.runs)).filter((r) => inScope(r, scope) && matches(r)), (r) => r.summary.startedAt, q.limit);
  }
  async putComparisonReport(c: ComparisonReport) {
    return this.docs.exclusive(async () => {
      if (!(await this.getProject(c.tenantId, c.project))) return "no_project" as const;
      const id = await keys.comparison(c);
      const existing = await this.docs.get<ComparisonReport>(KINDS.comparisons, id);
      if (existing) return { created: false, report: existing };
      await this.docs.put(KINDS.comparisons, id, c);
      return { created: true, report: c };
    });
  }
  async listComparisonReports(scope: ProjectScope, q: ComparisonReportQuery = {}) {
    const matches = (c: ComparisonReport) => (!q.name || c.name === q.name) && (!q.headVersionId || c.head.rubricVersionId === q.headVersionId);
    return newest((await this.docs.all<ComparisonReport>(KINDS.comparisons)).filter((c) => inScope(c, scope) && matches(c)), (c) => c.reportedAt, q.limit);
  }

  async prune(tenantId: string | undefined, before: string) {
    await this.docs.exclusive(async () => {
      const latest = latestPerPointer((await this.docs.all<PromotionEvent>(KINDS.promotions)).filter((e) => inTenant(e, tenantId)));
      await this.removeWhere<PromotionEvent>(KINDS.promotions, (e) => inTenant(e, tenantId) && e.at < before && !latest.has(e.id), keys.promotion);
      await this.removeWhere<RunReport>(KINDS.runs, (r) => inTenant(r, tenantId) && r.reportedAt < before, (r) => keys.run(r, r.summary.runId));
      await this.removeWhere<ComparisonReport>(KINDS.comparisons, (c) => inTenant(c, tenantId) && c.reportedAt < before, keys.comparison);
    });
  }

  async usage(tenantId: string | undefined, since: string) {
    const count = async <T extends { tenantId?: string }>(kind: string, matches: (item: T) => boolean = () => true) =>
      (await this.docs.all<T>(kind)).filter((item) => inTenant(item, tenantId) && matches(item)).length;
    return {
      projects: await count(KINDS.projects), environments: await count(KINDS.environments), versions: await count(KINDS.versions),
      reports: (await count<RunReport>(KINDS.runs, (r) => r.reportedAt >= since)) + (await count<ComparisonReport>(KINDS.comparisons, (c) => c.reportedAt >= since)),
    };
  }

  /** The first reason these events cannot all apply, if any. */
  private async refusal(events: PromotionEvent[]): Promise<PromotionRefusal | undefined> {
    for (const e of events) if (!(await this.getEnvironment(e, e.environment))) return "no_environment";
    for (const e of events) if (e.to !== null && !(await this.getVersion(e, e.name, e.to))) return "unknown_version";
    for (const e of events) {
      const current = await this.docs.get<Pointer>(KINDS.pointers, await keys.pointer(e));
      if ((current?.versionId ?? null) !== e.from) return "conflict";
    }
    return undefined;
  }

  private async removeWhere<T>(kind: string, matches: (item: T) => boolean, keyOf: (item: T) => Promise<string>) {
    for (const item of await this.docs.all<T>(kind)) if (matches(item)) await this.docs.remove(kind, await keyOf(item));
  }
}

/** Ids of the newest event of each pointer (project, environment, rubric name): what a rollback reads. */
function latestPerPointer(events: PromotionEvent[]): Set<string> {
  const newest = new Map<string, PromotionEvent>();
  for (const e of events) {
    const pointer = JSON.stringify([e.project, e.environment, e.name]), seen = newest.get(pointer);
    if (!seen || e.at > seen.at || (e.at === seen.at && e.id > seen.id)) newest.set(pointer, e);
  }
  return new Set([...newest.values()].map((e) => e.id));
}

function pointerOf(e: PromotionEvent, versionId: string): Pointer {
  return { ...(e.tenantId === undefined ? {} : { tenantId: e.tenantId }), project: e.project, environment: e.environment, name: e.name, versionId, updatedAt: e.at };
}

/** Documents kept in memory; mutations queue behind one another. */
export function memoryControlDocs(): ControlDocs {
  const kinds = new Map<string, Map<string, unknown>>();
  const of = (kind: string) => kinds.get(kind) ?? kinds.set(kind, new Map()).get(kind)!;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    get: async <T>(kind: string, id: string) => of(kind).get(id) as T | undefined,
    put: async (kind, id, value) => { of(kind).set(id, value); },
    remove: async (kind, id) => { of(kind).delete(id); },
    all: async <T>(kind: string) => [...of(kind).values()] as T[],
    exclusive: <T>(work: () => Promise<T>) => {
      const run = tail.then(work);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
