/**
 * The control plane on SQL (docs/design/control-plane.md §9.3). Reads are plain tenant-and-project-scoped selects.
 * Writes whose outcome depends on other rows carry that condition inside the statement — an insert that only happens
 * while its guard holds — and run through `atomic`, because D1 offers atomic batches but no interactive transaction.
 * The outcome is then read back. The same statements run on SQLite, D1 and Postgres.
 */
import {
  checkPromotionBatch, CONTROL_LIST_LIMIT,
  type ComparisonReport, type ComparisonReportQuery, type ControlStore, type ControlUsage, type Environment, type HistoryQuery, type Pointer, type Project,
  type ProjectScope, type ProjectVersion, type PromotionEvent, type PromotionRefusal, type RubricName, type RunReport, type RunReportQuery,
} from "@verdict-ai/core";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Atomic } from "./dialects.js";
import { storeOperation } from "./errors.js";
import type { DocumentQueries } from "./queries.js";

// A missing tenant is stored as "": NULLs never collide in a key, so they could not scope anything.
const tenantOf = (tenantId: string | undefined) => tenantId ?? "";
const withTenant = <T extends object>(tenant: string, rest: T): T & { tenantId?: string } => (tenant ? { tenantId: tenant, ...rest } : rest);
const lockOf = (tenant: string, project: string) => `control:${tenant}:${project}`;
const all = (conditions: Array<SQL | undefined>) => and(...conditions.filter((c): c is SQL => !!c));
const any = (conditions: SQL[]) => sql`(${sql.join(conditions, sql` or `)})`;

export class DrizzleControlStore implements ControlStore {
  constructor(private queries: DocumentQueries, private atomic: Atomic) { }

  /* ---------------- projects and environments ---------------- */

  async createProject(p: Project): Promise<boolean> {
    return storeOperation(`createProject:${p.name}`, async () => {
      const t = tenantOf(p.tenantId);
      if (await this.getProject(p.tenantId, p.name)) return false;
      await this.atomic([sql`insert into projects (tenant_id, name, created_at) values (${t}, ${p.name}, ${p.createdAt}) on conflict (tenant_id, name) do nothing`], lockOf(t, p.name));
      return (await this.getProject(p.tenantId, p.name))?.createdAt === p.createdAt;
    });
  }

  async getProject(tenantId: string | undefined, name: string): Promise<Project | undefined> {
    return storeOperation(`getProject:${name}`, async () => {
      const { projects } = this.queries.tables;
      const [row] = await this.queries.select("projects", { where: and(eq(projects.tenantId, tenantOf(tenantId)), eq(projects.name, name)), limit: 1 });
      return row ? withTenant(row.tenantId, { name: row.name, createdAt: row.createdAt }) : undefined;
    });
  }

  async listProjects(tenantId: string | undefined): Promise<Project[]> {
    return storeOperation("listProjects", async () => {
      const { projects } = this.queries.tables;
      const rows = await this.queries.select("projects", { where: eq(projects.tenantId, tenantOf(tenantId)), orderBy: sql`${projects.createdAt} asc, ${projects.name} asc` });
      return rows.map((row) => withTenant(row.tenantId, { name: row.name, createdAt: row.createdAt }));
    });
  }

  async deleteProject(tenantId: string | undefined, name: string): Promise<boolean> {
    return storeOperation(`deleteProject:${name}`, async () => {
      if (!(await this.getProject(tenantId, name))) return false;
      const t = tenantOf(tenantId);
      const inProject = sql`tenant_id = ${t} and project = ${name}`;
      await this.atomic([
        sql`delete from pointers where ${inProject}`, sql`delete from promotions where ${inProject}`,
        sql`delete from run_reports where ${inProject}`, sql`delete from comparison_reports where ${inProject}`,
        sql`delete from project_versions where ${inProject}`, sql`delete from environments where ${inProject}`,
        sql`delete from projects where tenant_id = ${t} and name = ${name}`,
      ], lockOf(t, name));
      return true;
    });
  }

  async createEnvironment(e: Environment): Promise<"created" | "exists" | "no_project"> {
    return storeOperation(`createEnvironment:${e.name}`, async () => {
      const t = tenantOf(e.tenantId);
      if (await this.getEnvironment(e, e.name)) return "exists";
      await this.atomic([sql`insert into environments (tenant_id, project, name, created_at)
        select ${t}, ${e.project}, ${e.name}, ${e.createdAt} where ${projectExists(t, e.project)}
        on conflict (tenant_id, project, name) do nothing`], lockOf(t, e.project));
      const stored = await this.getEnvironment(e, e.name);
      if (!stored) return "no_project";
      return stored.createdAt === e.createdAt ? "created" : "exists";
    });
  }

  async getEnvironment(scope: ProjectScope, name: string): Promise<Environment | undefined> {
    return (await this.environments(scope, name))[0];
  }

  async listEnvironments(scope: ProjectScope): Promise<Environment[]> {
    return this.environments(scope);
  }

  async deleteEnvironment(scope: ProjectScope, name: string): Promise<boolean> {
    return storeOperation(`deleteEnvironment:${name}`, async () => {
      if (!(await this.getEnvironment(scope, name))) return false;
      const t = tenantOf(scope.tenantId);
      await this.atomic([
        sql`delete from pointers where tenant_id = ${t} and project = ${scope.project} and environment = ${name}`,
        sql`delete from environments where tenant_id = ${t} and project = ${scope.project} and name = ${name}`,
      ], lockOf(t, scope.project));
      return true;
    });
  }

  /* ---------------- versions ---------------- */

  async putVersion(v: ProjectVersion): Promise<{ created: boolean; version: ProjectVersion } | "no_project"> {
    return storeOperation(`putVersion:${v.id}`, async () => {
      const t = tenantOf(v.tenantId);
      const existing = await this.getVersion(v, v.name, v.id);
      if (existing) return { created: false, version: existing };
      await this.atomic([sql`insert into project_versions (tenant_id, project, rubric_name, version_id, doc, created_at)
        select ${t}, ${v.project}, ${v.name}, ${v.id}, ${JSON.stringify(v)}, ${v.createdAt} where ${projectExists(t, v.project)}
        on conflict (tenant_id, project, rubric_name, version_id) do nothing`], lockOf(t, v.project));
      const stored = await this.getVersion(v, v.name, v.id);
      return stored ? { created: stored.createdAt === v.createdAt, version: stored } : "no_project";
    });
  }

  async getVersion(scope: ProjectScope, name: string, id: string): Promise<ProjectVersion | undefined> {
    return storeOperation(`getVersion:${id}`, async () => {
      const { projectVersions: t } = this.queries.tables;
      const [row] = await this.queries.select("projectVersions", { where: and(eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), eq(t.name, name), eq(t.id, id)), limit: 1 });
      return row ? (row.doc as unknown as ProjectVersion) : undefined;
    });
  }

  async listVersions(scope: ProjectScope, o: { name?: string; limit?: number } = {}): Promise<ProjectVersion[]> {
    return storeOperation("listVersions", async () => {
      const { projectVersions: t } = this.queries.tables;
      const where = all([eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), o.name ? eq(t.name, o.name) : undefined]);
      const rows = await this.queries.select("projectVersions", { where, orderBy: sql`${t.createdAt} desc`, limit: o.limit ?? CONTROL_LIST_LIMIT });
      return rows.map((row) => row.doc as unknown as ProjectVersion);
    });
  }

  async listRubricNames(scope: ProjectScope): Promise<RubricName[]> {
    return storeOperation("listRubricNames", async () => {
      const rows = await this.queries.rows(sql`select rubric_name as name, count(*) as versions, max(created_at) as updated_at from project_versions
        where tenant_id = ${tenantOf(scope.tenantId)} and project = ${scope.project} group by rubric_name order by rubric_name asc`);
      // Postgres counts in bigint, which its driver returns as a string.
      return rows.map((row) => ({ name: String(row.name), versions: Number(row.versions), updatedAt: String(row.updated_at) }));
    });
  }

  async deleteVersion(scope: ProjectScope, name: string, id: string): Promise<"deleted" | "not_found" | "in_use"> {
    return storeOperation(`deleteVersion:${id}`, async () => {
      if (!(await this.getVersion(scope, name, id))) return "not_found";
      const t = tenantOf(scope.tenantId);
      const here = sql`tenant_id = ${t} and project = ${scope.project} and rubric_name = ${name} and version_id = ${id}`;
      await this.atomic([sql`delete from project_versions where ${here} and not exists (select 1 from pointers where ${here})`], lockOf(t, scope.project));
      return (await this.getVersion(scope, name, id)) ? "in_use" : "deleted";
    });
  }

  /* ---------------- pointers and history ---------------- */

  async listPointers(scope: ProjectScope, environment: string): Promise<Pointer[]> {
    return storeOperation(`listPointers:${environment}`, async () => {
      const { pointers: t } = this.queries.tables;
      const rows = await this.queries.select("pointers", { where: and(eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), eq(t.environment, environment)), orderBy: sql`${t.name} asc` });
      return rows.map((row) => withTenant(row.tenantId, { project: row.project, environment: row.environment, name: row.name, versionId: row.versionId, updatedAt: row.updatedAt }));
    });
  }

  async applyPromotions(events: PromotionEvent[]): Promise<{ ok: true } | { ok: false; reason: PromotionRefusal }> {
    checkPromotionBatch(events);
    return storeOperation("applyPromotions", async () => {
      const first = events[0]!, t = tenantOf(first.tenantId);
      await this.atomic(promotionStatements(events, t), lockOf(t, first.project));
      const { promotions } = this.queries.tables;
      const [applied] = await this.queries.select("promotions", { where: and(eq(promotions.tenantId, t), eq(promotions.project, first.project), eq(promotions.id, first.id)), limit: 1 });
      return applied ? { ok: true } : { ok: false, reason: await this.refusal(events) };
    });
  }

  async listHistory(scope: ProjectScope, q: HistoryQuery = {}): Promise<PromotionEvent[]> {
    return storeOperation("listHistory", async () => {
      const { promotions: t } = this.queries.tables;
      const where = all([eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), q.environment ? eq(t.environment, q.environment) : undefined, q.name ? eq(t.name, q.name) : undefined]);
      const rows = await this.queries.select("promotions", { where, orderBy: sql`${t.createdAt} desc, ${t.id} desc`, limit: q.limit ?? CONTROL_LIST_LIMIT });
      return rows.map((row) => row.doc as unknown as PromotionEvent);
    });
  }

  /* ---------------- reports ---------------- */

  async putRunReport(r: RunReport): Promise<{ created: boolean; report: RunReport } | "no_project"> {
    return storeOperation(`putRunReport:${r.summary.runId}`, async () => {
      const t = tenantOf(r.tenantId), s = r.summary;
      const existing = await this.getRunReport(r, s.runId);
      if (existing) return { created: false, report: existing };
      await this.atomic([sql`insert into run_reports (tenant_id, project, run_id, rubric_name, version_id, dataset_name, started_at, doc, reported_at)
        select ${t}, ${r.project}, ${s.runId}, ${r.name}, ${s.rubricVersionId}, ${r.datasetName ?? null}, ${s.startedAt}, ${JSON.stringify(r)}, ${r.reportedAt}
        where ${projectExists(t, r.project)} on conflict (tenant_id, project, run_id) do nothing`], lockOf(t, r.project));
      const stored = await this.getRunReport(r, s.runId);
      return stored ? { created: stored.reportedAt === r.reportedAt, report: stored } : "no_project";
    });
  }

  async getRunReport(scope: ProjectScope, runId: string): Promise<RunReport | undefined> {
    return storeOperation(`getRunReport:${runId}`, async () => {
      const { runReports: t } = this.queries.tables;
      const [row] = await this.queries.select("runReports", { where: and(eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), eq(t.runId, runId)), limit: 1 });
      return row ? (row.doc as unknown as RunReport) : undefined;
    });
  }

  async listRunReports(scope: ProjectScope, q: RunReportQuery = {}): Promise<RunReport[]> {
    return storeOperation("listRunReports", async () => {
      const { runReports: t } = this.queries.tables;
      const where = all([
        eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), q.name ? eq(t.name, q.name) : undefined,
        q.versionId ? eq(t.versionId, q.versionId) : undefined, q.datasetName ? eq(t.datasetName, q.datasetName) : undefined,
      ]);
      const rows = await this.queries.select("runReports", { where, orderBy: sql`${t.startedAt} desc`, limit: q.limit ?? CONTROL_LIST_LIMIT });
      return rows.map((row) => row.doc as unknown as RunReport);
    });
  }

  async putComparisonReport(c: ComparisonReport): Promise<{ created: boolean; report: ComparisonReport } | "no_project"> {
    return storeOperation(`putComparisonReport:${c.id}`, async () => {
      const t = tenantOf(c.tenantId);
      const existing = await this.comparison(c, c.id);
      if (existing) return { created: false, report: existing };
      await this.atomic([sql`insert into comparison_reports (tenant_id, project, id, rubric_name, head_version_id, doc, reported_at)
        select ${t}, ${c.project}, ${c.id}, ${c.name}, ${c.head.rubricVersionId}, ${JSON.stringify(c)}, ${c.reportedAt}
        where ${projectExists(t, c.project)} on conflict (tenant_id, project, id) do nothing`], lockOf(t, c.project));
      const stored = await this.comparison(c, c.id);
      return stored ? { created: stored.reportedAt === c.reportedAt, report: stored } : "no_project";
    });
  }

  async listComparisonReports(scope: ProjectScope, q: ComparisonReportQuery = {}): Promise<ComparisonReport[]> {
    return storeOperation("listComparisonReports", async () => {
      const { comparisonReports: t } = this.queries.tables;
      const where = all([eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), q.name ? eq(t.name, q.name) : undefined, q.headVersionId ? eq(t.headVersionId, q.headVersionId) : undefined]);
      const rows = await this.queries.select("comparisonReports", { where, orderBy: sql`${t.reportedAt} desc`, limit: q.limit ?? CONTROL_LIST_LIMIT });
      return rows.map((row) => row.doc as unknown as ComparisonReport);
    });
  }

  async prune(tenantId: string | undefined, before: string): Promise<void> {
    return storeOperation("prune", async () => {
      const t = tenantOf(tenantId);
      await this.atomic([
        // The newest event of each pointer stays whatever its age: a rollback reads it.
        sql`delete from promotions where tenant_id = ${t} and created_at < ${before} and exists (
          select 1 from promotions newer where newer.tenant_id = promotions.tenant_id and newer.project = promotions.project
            and newer.environment = promotions.environment and newer.rubric_name = promotions.rubric_name
            and (newer.created_at > promotions.created_at or (newer.created_at = promotions.created_at and newer.id > promotions.id)))`,
        sql`delete from run_reports where tenant_id = ${t} and reported_at < ${before}`,
        sql`delete from comparison_reports where tenant_id = ${t} and reported_at < ${before}`,
      ], `control:${t}`);
    });
  }

  async usage(tenantId: string | undefined, since: string): Promise<ControlUsage> {
    return storeOperation("usage", async () => {
      const t = tenantOf(tenantId);
      const [row = {}] = await this.queries.rows(sql`select
        (select count(*) from projects where tenant_id = ${t}) as projects,
        (select count(*) from environments where tenant_id = ${t}) as environments,
        (select count(*) from project_versions where tenant_id = ${t}) as versions,
        (select count(*) from run_reports where tenant_id = ${t} and reported_at >= ${since})
          + (select count(*) from comparison_reports where tenant_id = ${t} and reported_at >= ${since}) as reports`);
      // Postgres counts in bigint, which its driver returns as a string.
      return { projects: Number(row.projects), environments: Number(row.environments), versions: Number(row.versions), reports: Number(row.reports) };
    });
  }

  private async environments(scope: ProjectScope, name?: string): Promise<Environment[]> {
    return storeOperation("environments", async () => {
      const { environments: t } = this.queries.tables;
      const where = all([eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), name === undefined ? undefined : eq(t.name, name)]);
      const rows = await this.queries.select("environments", { where, orderBy: sql`${t.createdAt} asc, ${t.name} asc` });
      return rows.map((row) => withTenant(row.tenantId, { project: row.project, name: row.name, createdAt: row.createdAt }));
    });
  }

  private async comparison(scope: ProjectScope, id: string): Promise<ComparisonReport | undefined> {
    const { comparisonReports: t } = this.queries.tables;
    const [row] = await this.queries.select("comparisonReports", { where: and(eq(t.tenantId, tenantOf(scope.tenantId)), eq(t.project, scope.project), eq(t.id, id)), limit: 1 });
    return row ? (row.doc as unknown as ComparisonReport) : undefined;
  }

  /** Why the guard of a refused batch did not hold; only read after nothing was applied. */
  private async refusal(events: PromotionEvent[]): Promise<PromotionRefusal> {
    const first = events[0]!;
    if (!(await this.getEnvironment(first, first.environment))) return "no_environment";
    for (const e of events) if (e.to !== null && !(await this.getVersion(e, e.name, e.to))) return "unknown_version";
    return "conflict";
  }
}

const projectExists = (tenant: string, project: string) => sql`exists (select 1 from projects where tenant_id = ${tenant} and name = ${project})`;

/**
 * History rows first, each inserted only while the whole batch may apply; then the pointer changes, each tied to its
 * history row. Either every statement takes effect or none does, and the guard is evaluated before any pointer moves.
 */
function promotionStatements(events: PromotionEvent[], tenant: string): SQL[] {
  const guard = promotionGuard(events, tenant);
  const { project, environment } = events[0]!;
  const history = events.map((e) => sql`insert into promotions (tenant_id, project, id, environment, rubric_name, doc, created_at)
    select ${tenant}, ${project}, ${e.id}, ${environment}, ${e.name}, ${JSON.stringify(e)}, ${e.at} where ${guard}`);
  const moves = events.map((e) => {
    const recorded = sql`exists (select 1 from promotions where tenant_id = ${tenant} and project = ${project} and id = ${e.id})`;
    if (e.to === null) return sql`delete from pointers where tenant_id = ${tenant} and project = ${project} and environment = ${environment} and rubric_name = ${e.name} and ${recorded}`;
    return sql`insert into pointers (tenant_id, project, environment, rubric_name, version_id, updated_at)
      select ${tenant}, ${project}, ${environment}, ${e.name}, ${e.to}, ${e.at} where ${recorded}
      on conflict (tenant_id, project, environment, rubric_name) do update set version_id = excluded.version_id, updated_at = excluded.updated_at`;
  });
  return [...history, ...moves];
}

/** True while the environment exists, every pointer is where its event says, and every target version is kept under its name. */
function promotionGuard(events: PromotionEvent[], tenant: string): SQL {
  const { project, environment } = events[0]!;
  const here = sql`tenant_id = ${tenant} and project = ${project} and environment = ${environment}`;
  const conditions: SQL[] = [sql`exists (select 1 from environments where tenant_id = ${tenant} and project = ${project} and name = ${environment})`];
  const moved = events.filter((e) => e.from !== null), fresh = events.filter((e) => e.from === null), targets = events.filter((e) => e.to !== null);
  if (moved.length) conditions.push(sql`(select count(*) from pointers where ${here} and ${any(moved.map((e) => sql`(rubric_name = ${e.name} and version_id = ${e.from})`))}) = ${sql.raw(String(moved.length))}`);
  if (fresh.length) conditions.push(sql`not exists (select 1 from pointers where ${here} and ${any(fresh.map((e) => sql`rubric_name = ${e.name}`))})`);
  if (targets.length) conditions.push(sql`(select count(*) from project_versions where tenant_id = ${tenant} and project = ${project} and ${any(targets.map((e) => sql`(rubric_name = ${e.name} and version_id = ${e.to})`))}) = ${sql.raw(String(targets.length))}`);
  return sql.join(conditions, sql` and `);
}
