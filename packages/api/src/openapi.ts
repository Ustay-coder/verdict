/**
 * Describes the public REST operations for API discovery.
 * The published paths mirror route registration; runtime validation remains owned by request schemas.
 */
import type { RouteGroup } from "./app.js";

const GROUP_PATHS: Record<RouteGroup, string[]> = {
  evaluations: ["/v1/evaluations", "/v1/tasks", "/v1/batches"],
  rubrics: ["/v1/rubrics"],
  hub: ["/v1/hub", "/v1/public", "/v1/publications"],
  control: ["/v1/projects"],
};

/** The document for an app that serves only some route groups: paths of the others are left out. */
export function openapiFor(groups: readonly RouteGroup[]) {
  const off = (Object.keys(GROUP_PATHS) as RouteGroup[]).filter((g) => !groups.includes(g)).flatMap((g) => GROUP_PATHS[g]);
  const served = (path: string) => !off.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return { ...openapi, paths: Object.fromEntries(Object.entries(openapi.paths).filter(([path]) => served(path))) };
}

export const openapi = {
  openapi: "3.1.0",
  info: { title: "Verdict Evaluation API", version: "0.1.0", description: "Customizable rubrics, pluggable judges (LLM / human / benchmark), customizable aggregation." },
  servers: [{ url: "/" }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/v1/rubrics": { post: { summary: "Create rubric (JSON or YAML body)" }, get: { summary: "List rubrics" } },
    "/v1/rubrics/validate": { post: { summary: "Validate a rubric without storing it" } },
    "/v1/rubrics/{id}": { get: { summary: "Get rubric" }, put: { summary: "Replace rubric" }, delete: { summary: "Delete rubric" } },
    "/v1/rubrics/{id}/calibration": { get: { summary: "Calibration report (`?target=0.8&buckets=5&limit=1000`)" } },
    "/v1/evaluations": { post: { summary: "Evaluate a subject (sync; `async:true` for 202). Optional Idempotency-Key header (1–255 chars); replay 200, conflict 409, TTL 24h" }, get: { summary: "List evaluations" } },
    "/v1/evaluations/{id}": { get: { summary: "Get evaluation (`?evidence=true` for full text)" } },
    "/v1/evaluations/{id}/retry": { post: { summary: "Re-enqueue a failed evaluation (202; unknown 404; not failed 409)" } },
    "/v1/evaluations/{id}/scores": { post: { summary: "Submit a human score for a pending criterion" } },
    "/v1/evaluations/{id}/aggregate": { post: { summary: "Re-aggregate with a different aggregation config (no re-judging)" } },
    "/v1/tasks": { get: { summary: "Pending human-rating tasks (`?rater=`)" } },
    "/v1/batches": { post: { summary: "Evaluate many subjects against one rubric and rank them. Optional Idempotency-Key header (1–255 chars); replay 200, conflict 409, TTL 24h" } },
    "/v1/hub/config": { get: { summary: "Public: the GitHub OAuth client id for sign-in (null when the server publishes under tenant ids), and `signIn` when the server runs CLI sign-in itself (browser approval)" } },
    "/v1/hub/login": { post: { summary: "Public: trade a GitHub token from the device flow for a hub API key bound to that account (201 { apiKey, keyId, handle, tenantId })" } },
    "/v1/hub/me": { get: { summary: "Who this key publishes as" } },
    "/v1/hub/keys/{id}": { delete: { summary: "Revoke one of this account's hub keys (sign out)" } },
    "/v1/public/rubrics": { get: { summary: "Public, no key: search published cards (q, domain, locale, type, owner, limit ≤ 50); one result per owner/slug at its newest live version", security: [] } },
    "/v1/public/rubrics/{owner}/{slug}": { get: { summary: "Public, no key: a card at ?version= (default: newest live) with its version history; 410 when that version was withdrawn", security: [] } },
    "/v1/public/publications/{id}": { get: { summary: "Public, no key: one publication by id; 410 when withdrawn", security: [] } },
    "/v1/publications": { post: { summary: "Publish a rubric version, chosen public cases and run summaries to the hub (one criterion, licence, binary threshold; 400 with issues)" }, get: { summary: "List this tenant's publications, withdrawn included" } },
    "/v1/publications/preview": { post: { summary: "Build the publication without storing it: { ok, issues, warnings, publication } — the exact document publish would store" } },
    "/v1/publications/{id}": { delete: { summary: "Withdraw a publication (it stays readable by id, marked withdrawn, and leaves search)" } },
    "/v1/projects": { post: { summary: "Create a project: { name } (201; 409 already_exists)" }, get: { summary: "List this tenant's projects" } },
    "/v1/projects/{project}": { delete: { summary: "Delete a project and everything in it. Body { confirm: \"<name>\" }" } },
    "/v1/projects/{project}/environments": { post: { summary: "Create an environment: { name } (201; 409 already_exists)" }, get: { summary: "List a project's environments" } },
    "/v1/projects/{project}/environments/{environment}": { get: { summary: "An environment and its pointers: which version of each rubric it runs. `?include=rubrics` adds each rubric document (what services poll); answers carry an ETag, and If-None-Match gets 304 while nothing changed" }, delete: { summary: "Delete an environment and its pointers; its history stays. Body { confirm: \"<name>\" }" } },
    "/v1/projects/{project}/environments/{environment}/promotions": { post: { summary: "Move pointers, all or none: { changes: [{ name, versionId | null, expected | null }], note? } (≤ 20 changes; null versionId removes the pointer; 409 pointer_conflict with the current versions when `expected` is stale)" } },
    "/v1/projects/{project}/environments/{environment}/rollbacks": { post: { summary: "Undo a pointer's latest change: { name, expected, note? } (409 pointer_conflict / nothing_to_roll_back)" } },
    "/v1/projects/{project}/history": { get: { summary: "Pointer changes, newest first (`?environment=&name=&limit=`)" } },
    "/v1/projects/{project}/rubrics": { get: { summary: "Rubric names of a project, with version counts" } },
    "/v1/projects/{project}/rubrics/{name}/versions": { post: { summary: "Upload an immutable rubric version: { id, rubric, parentVersionId?, fork? }. The server freezes the rubric again and refuses another id (201 new, 200 already there, 413 over 1 MB)" }, get: { summary: "List a rubric's versions, newest first, without the rubric documents" } },
    "/v1/projects/{project}/rubrics/{name}/versions/{id}": { get: { summary: "One version with its rubric document" }, delete: { summary: "Delete a version no environment points at (409 in_use otherwise)" } },
    "/v1/projects/{project}/reports/runs": { post: { summary: "Report a run's numbers: { name, run, report, datasetName?, source?, version? }. No case ids, inputs or outputs are read. `version` uploads the run's rubric version when the server lacks it (201 new, 200 already reported, 400 unknown_version)" }, get: { summary: "Run reports, newest run first (`?name=&versionId=&dataset=&limit=`)" } },
    "/v1/projects/{project}/reports/runs/{runId}": { get: { summary: "One run report" } },
    "/v1/projects/{project}/reports/comparisons": { post: { summary: "Report a comparison of two reported runs: { name, comparison, source? } — counts per criterion, no per-case rows (400 unknown_run)" }, get: { summary: "Comparison reports, newest first (`?name=&head=&limit=`)" } },
    "/v1/admin/keys": { post: { summary: "Create an API key for a tenant (admin)" }, get: { summary: "List a tenant's keys (admin, `?tenant=`)" } },
    "/v1/admin/keys/{id}": { delete: { summary: "Revoke a key (admin)" } },
  },
};
