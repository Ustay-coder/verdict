/**
 * Projects and environments of the control plane (docs/design/control-plane.md §3, §5.3). Authenticated and
 * tenant-scoped; every handler asks `allow` before it touches the store.
 */
import { ConfirmRequest, fingerprint, NameRequest, NotFoundError, ValidationError, type ControlStore, type ProjectScope, type Rubric } from "@verdict-ai/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppOptions, Env } from "../app.js";
import { ApiError, bare, controlContext, projectNotFound, readJson, tenant } from "./shared.js";

/** Deleting takes the name twice: once in the URL, once in the body. */
async function confirmed(req: Request, name: string, what: string) {
  const { confirm } = ConfirmRequest.parse(await readJson(req));
  if (confirm !== name) throw new ValidationError(`to delete ${what} ${name}, send { "confirm": "${name}" }`);
}

/** The document a pointer names. A pointed-at version cannot be deleted, so a miss means the pointer just moved. */
async function rubricOf(store: ControlStore, scope: ProjectScope, pointer: { name: string; versionId: string }): Promise<Rubric> {
  const version = await store.getVersion(scope, pointer.name, pointer.versionId);
  if (!version) throw new HTTPException(503, { message: `${pointer.name} changed while it was being read; ask again` });
  return version.rubric;
}

/** Registers project and environment routes. */
export function registerProjects(app: Hono<Env>, options: AppOptions) {
  const { store, allow, at } = controlContext(options);

  app.post("/v1/projects", async (c) => {
    const { name } = NameRequest.parse(await readJson(c.req.raw));
    await allow(c, "project.create", { project: name });
    const tenantId = tenant(c), project = { ...(tenantId === undefined ? {} : { tenantId }), name, createdAt: at() };
    if (!(await store().createProject(project))) throw new ApiError(409, "already_exists", `project ${name} already exists`);
    return c.json(bare(project), 201);
  });

  app.get("/v1/projects", async (c) => {
    await allow(c, "project.read");
    return c.json({ data: (await store().listProjects(tenant(c))).map(bare) });
  });

  app.delete("/v1/projects/:project", async (c) => {
    const name = c.req.param("project");
    await allow(c, "project.delete", { project: name });
    await confirmed(c.req.raw, name, "project");
    if (!(await store().deleteProject(tenant(c), name))) throw projectNotFound(name);
    return c.body(null, 204);
  });

  registerEnvironments(app, options);
}

function registerEnvironments(app: Hono<Env>, options: AppOptions) {
  const { store, scope, allow, project, at } = controlContext(options);

  app.post("/v1/projects/:project/environments", async (c) => {
    const { name } = NameRequest.parse(await readJson(c.req.raw));
    const s = scope(c);
    await allow(c, "environment.create", { project: s.project, environment: name });
    const environment = { ...s, name, createdAt: at() };
    const result = await store().createEnvironment(environment);
    if (result === "no_project") throw projectNotFound(s.project);
    if (result === "exists") throw new ApiError(409, "already_exists", `environment ${name} already exists in project ${s.project}`);
    return c.json(bare(environment), 201);
  });

  app.get("/v1/projects/:project/environments", async (c) => {
    await allow(c, "environment.read", { project: c.req.param("project") });
    return c.json({ data: (await store().listEnvironments(await project(c))).map(bare) });
  });

  // What a service polls: `?include=rubrics` returns the documents too, so one answer holds everything an environment
  // runs. Versions never change, so the pointers alone identify the answer: an unchanged environment answers 304.
  app.get("/v1/projects/:project/environments/:environment", async (c) => {
    const s = scope(c), name = c.req.param("environment"), withRubrics = c.req.query("include") === "rubrics";
    await allow(c, "environment.read", { project: s.project, environment: name });
    const environment = await store().getEnvironment(s, name);
    if (!environment) throw new NotFoundError(`environment ${name} not found in project ${s.project}`);
    const pointers = (await store().listPointers(s, name)).map((p) => ({ name: p.name, versionId: p.versionId, updatedAt: p.updatedAt }));
    const etag = `"${await fingerprint([environment.createdAt, withRubrics, pointers.map((p) => [p.name, p.versionId])])}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "private, no-cache");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    if (!withRubrics) return c.json({ ...bare(environment), pointers });
    return c.json({ ...bare(environment), pointers: await Promise.all(pointers.map(async (p) => ({ ...p, rubric: await rubricOf(store(), s, p) }))) });
  });

  app.delete("/v1/projects/:project/environments/:environment", async (c) => {
    const s = scope(c), name = c.req.param("environment");
    await allow(c, "environment.delete", { project: s.project, environment: name });
    await confirmed(c.req.raw, name, "environment");
    if (!(await store().deleteEnvironment(s, name))) throw new NotFoundError(`environment ${name} not found in project ${s.project}`);
    return c.body(null, 204);
  });
}
