/**
 * Immutable rubric versions kept in a project (docs/design/control-plane.md §4). A version is stored under the name
 * services ask for; the server freezes the uploaded rubric again and refuses an id that does not match its content.
 */
import { CONTROL_LIST_LIMIT, CONTROL_VERSION_BYTES, controlName, NotFoundError, projectVersion, VersionUpload, type ProjectVersion } from "@verdict-ai/core";
import { Hono } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { ApiError, bare, controlContext, projectNotFound, readJson } from "./shared.js";

/** A version as lists show it: everything but the rubric document. */
function listed(v: ProjectVersion) {
  const { rubric: _rubric, ...rest } = bare(v);
  return rest;
}

/** Registers version routes. */
export function registerProjectVersions(app: Hono<Env>, options: AppOptions) {
  const { store, scope, allow, project, now } = controlContext(options);
  const base = "/v1/projects/:project/rubrics";
  const missing = (name: string, id: string, projectName: string) => new NotFoundError(`version ${id} of ${name} not found in project ${projectName}`);

  app.post(`${base}/:name/versions`, async (c) => {
    const s = scope(c), name = c.req.param("name");
    await allow(c, "version.put", { project: s.project, name });
    const upload = VersionUpload.parse(await readJson(c.req.raw, CONTROL_VERSION_BYTES));
    const result = await store().putVersion(await projectVersion(upload, s, controlName(name, "rubric"), now));
    if (result === "no_project") throw projectNotFound(s.project);
    return c.json({ version: bare(result.version), created: result.created }, result.created ? 201 : 200);
  });

  app.get(base, async (c) => {
    await allow(c, "version.read", { project: c.req.param("project") });
    return c.json({ data: await store().listRubricNames(await project(c)) });
  });

  app.get(`${base}/:name/versions`, async (c) => {
    const name = c.req.param("name");
    await allow(c, "version.read", { project: c.req.param("project"), name });
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(CONTROL_LIST_LIMIT).default(CONTROL_LIST_LIMIT) }).parse(c.req.query());
    return c.json({ data: (await store().listVersions(await project(c), { name, limit })).map(listed) });
  });

  app.get(`${base}/:name/versions/:id`, async (c) => {
    const s = scope(c), name = c.req.param("name"), id = c.req.param("id");
    await allow(c, "version.read", { project: s.project, name, versionId: id });
    const version = await store().getVersion(s, name, id);
    if (!version) throw missing(name, id, s.project);
    return c.json(bare(version));
  });

  app.delete(`${base}/:name/versions/:id`, async (c) => {
    const s = scope(c), name = c.req.param("name"), id = c.req.param("id");
    await allow(c, "version.delete", { project: s.project, name, versionId: id });
    const result = await store().deleteVersion(s, name, id);
    if (result === "not_found") throw missing(name, id, s.project);
    if (result === "in_use") throw new ApiError(409, "in_use", `an environment points at ${id}; promote another version of ${name} or remove the pointer first`);
    return c.body(null, 204);
  });
}
