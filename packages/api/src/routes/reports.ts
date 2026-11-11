/**
 * Reports of runs and comparisons (docs/design/control-plane.md §7): numbers a team's CI sends about runs it made
 * itself. The server cannot repeat a run, so every report is kept as reported by its author; it checks only that the
 * run names a version it holds (or receives with the report) and that version's hashes.
 */
import {
  CONTROL_LIST_LIMIT, CONTROL_VERSION_BYTES, ComparisonReportRequest, comparisonReport, NotFoundError, projectVersion, runReport, RunReportRequest, ValidationError,
  type ControlStore, type ProjectScope, type ProjectVersion,
} from "@verdict-ai/core";
import { Hono } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { ApiError, bare, controlContext, projectNotFound, readJson } from "./shared.js";

const limit = z.coerce.number().int().min(1).max(CONTROL_LIST_LIMIT).default(CONTROL_LIST_LIMIT);
const RunsQuery = z.object({ name: z.string().optional(), versionId: z.string().optional(), dataset: z.string().optional(), limit });
const ComparisonsQuery = z.object({ name: z.string().optional(), head: z.string().optional(), limit });

/** 404 for a project that is not there; otherwise the refusal the caller names. */
async function missing(store: ControlStore, scope: ProjectScope, otherwise: Error): Promise<Error> {
  return (await store.getProject(scope.tenantId, scope.project)) ? otherwise : projectNotFound(scope.project);
}

/** Registers report routes. */
export function registerReports(app: Hono<Env>, options: AppOptions) {
  const { store, scope, allow, project, at, now } = controlContext(options);
  const base = "/v1/projects/:project/reports";

  /** The version a run report is about: the one sent with it, else the one kept under that name. */
  const reportedVersion = async (s: ProjectScope, request: z.output<typeof RunReportRequest>): Promise<ProjectVersion> => {
    const id = request.run.rubricVersionId;
    if (request.version) {
      if (request.version.id !== id) throw new ValidationError(`the report sends version ${request.version.id} with a run of ${id}`);
      return projectVersion(request.version, s, request.name, now);
    }
    const kept = await store().getVersion(s, request.name, id);
    if (!kept) throw await missing(store(), s, new ApiError(400, "unknown_version", `version ${id} is not kept under ${request.name} in project ${s.project}; send it with the report`));
    return kept;
  };

  app.post(`${base}/runs`, async (c) => {
    const request = RunReportRequest.parse(await readJson(c.req.raw, CONTROL_VERSION_BYTES));
    const s = scope(c);
    // Covers the version sent along: a key that may report may bring the version its report is about.
    await allow(c, "report.put", { project: s.project, name: request.name, versionId: request.run.rubricVersionId });
    const version = await reportedVersion(s, request);
    const report = runReport(request, version, { scope: s, actor: c.get("actor"), at: at() });
    if (request.version && (await store().putVersion(version)) === "no_project") throw projectNotFound(s.project);
    const result = await store().putRunReport(report);
    if (result === "no_project") throw projectNotFound(s.project);
    return c.json({ report: bare(result.report), created: result.created }, result.created ? 201 : 200);
  });

  app.get(`${base}/runs`, async (c) => {
    const q = RunsQuery.parse(c.req.query());
    await allow(c, "report.read", { project: c.req.param("project"), name: q.name, versionId: q.versionId });
    const reports = await store().listRunReports(await project(c), { name: q.name, versionId: q.versionId, datasetName: q.dataset, limit: q.limit });
    return c.json({ data: reports.map(bare) });
  });

  app.get(`${base}/runs/:runId`, async (c) => {
    const s = scope(c), id = c.req.param("runId");
    await allow(c, "report.read", { project: s.project });
    const report = await store().getRunReport(s, id);
    if (!report) throw new NotFoundError(`no report of run ${id} in project ${s.project}`);
    return c.json(bare(report));
  });

  app.post(`${base}/comparisons`, async (c) => {
    const request = ComparisonReportRequest.parse(await readJson(c.req.raw));
    const s = scope(c), { base: from, head } = request.comparison;
    await allow(c, "report.put", { project: s.project, name: request.name, versionId: head.rubricVersionId });
    for (const side of [from, head]) {
      const run = await store().getRunReport(s, side.runId);
      if (!run) throw await missing(store(), s, new ApiError(400, "unknown_run", `run ${side.runId} has not been reported to project ${s.project}; report both runs first`));
      if (run.summary.rubricVersionId !== side.rubricVersionId) throw new ValidationError(`run ${side.runId} was reported as a run of ${run.summary.rubricVersionId}, not ${side.rubricVersionId}`);
    }
    const result = await store().putComparisonReport(await comparisonReport(request, { scope: s, actor: c.get("actor"), at: at() }));
    if (result === "no_project") throw projectNotFound(s.project);
    return c.json({ report: bare(result.report), created: result.created }, result.created ? 201 : 200);
  });

  app.get(`${base}/comparisons`, async (c) => {
    const q = ComparisonsQuery.parse(c.req.query());
    await allow(c, "report.read", { project: c.req.param("project"), name: q.name, versionId: q.head });
    const reports = await store().listComparisonReports(await project(c), { name: q.name, headVersionId: q.head, limit: q.limit });
    return c.json({ data: reports.map(bare) });
  });
}
