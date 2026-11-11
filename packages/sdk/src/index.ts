/**
 * Provides a typed client for Verdict REST operations and polling.
 * Idempotency replay metadata is preserved; transport failures use VerdictError and Workers-safe fetch.
 */
import type {
  CalibrationReport, Aggregation, ComparisonReport, ComparisonReportRequest, Environment, Evaluation, Input, Pointer, Project, ProjectVersion, PromotionEvent, PromotionRequest, Publication, PublicationIssue, PublicationRequest,
  PublicationResult, PublicListing, PublicPublication, PublicVersionEntry, RollbackRequest, Rubric, RubricInput, RubricName, RunReport, RunReportRequest, Subject, VersionUpload,
} from "@verdict-ai/core";

import { environmentReader, type EnvironmentOptions, type EnvironmentReader } from "./environment.js";
import { VerdictError } from "./errors.js";

export { VerdictError } from "./errors.js";
export type { EnvironmentOptions, EnvironmentReader, EnvironmentRubric } from "./environment.js";

export interface VerdictOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Request timeout in ms (sync evaluations can take a while). Default 10 min. */
  timeoutMs?: number;
  /** The organisation requests are about, on servers where one key reaches several (sent as `x-verdict-org`). Other servers ignore it. */
  org?: string;
}

/** How a server signs people in from the CLI when it runs the approval itself. */
export interface BrowserSignIn { kind: "browser"; start: string; token: string }

/** Documents as the control plane returns them: without the tenant they are stored under. */
export type ProjectView = Omit<Project, "tenantId">;
export type EnvironmentView = Omit<Environment, "tenantId">;
export type PointerView = Pick<Pointer, "name" | "versionId" | "updatedAt">;
export type VersionView = Omit<ProjectVersion, "tenantId">;
export type PromotionEventView = Omit<PromotionEvent, "tenantId">;
export type RunReportView = Omit<RunReport, "tenantId">;
export type ComparisonReportView = Omit<ComparisonReport, "tenantId">;

export interface EvaluateParams {
  rubric: string | RubricInput;
  inputs?: Input[];
  subject?: Subject;
  name?: string;
  metadata?: Record<string, unknown>;
  webhook?: string;
  includeEvidence?: boolean;
}

export type EvaluationView = Omit<Evaluation, "rubric" | "evidence"> & {
  rubric: Pick<Rubric, "id" | "name" | "version" | "aggregation">;
  evidence: Array<Record<string, unknown>>;
};

// why: synchronous judging can be slow; polling uses the same ten-minute default as individual requests.
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * Verdict client — mirrors the REST API 1:1.
 *
 *   const verdict = new Verdict({ apiKey: "sk_..." });
 *   const ev = await verdict.evaluations.create({ rubric: "rub_123", inputs: [{ type: "url", url: "https://..." }] });
 *   console.log(ev.aggregate.score, ev.aggregate.grade);
 */
export class Verdict {
  private apiKey?: string;
  private baseUrl: string;
  private f: typeof fetch;
  private timeoutMs: number;
  private org: Record<string, string>;

  constructor(opts: VerdictOptions = {}) {
    this.org = opts.org ? { "x-verdict-org": opts.org } : {};
    this.apiKey = opts.apiKey ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_API_KEY;
    this.baseUrl = (opts.baseUrl ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
    this.f = opts.fetch ?? ((input, init) => globalThis.fetch(input, init)); // bound call: Workers reject a detached fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(method: string, path: string, body?: unknown, contentType = "application/json", headers?: Record<string, string>): Promise<T> {
    return (await this.requestWithMeta<T>(method, path, body, contentType, headers)).data;
  }

  async requestWithMeta<T>(method: string, path: string, body?: unknown, contentType = "application/json", headers?: Record<string, string>): Promise<{ data: T; replayed: boolean }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.baseUrl}${path}`, {
        method,
        signal: ctrl.signal,
        headers: { "content-type": contentType, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.org, ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      // why: successful deletes have no JSON body to decode.
      if (res.status === 204) return { data: undefined as T, replayed: res.headers.get("Idempotency-Replayed") === "true" };
      const data = await responseBody(res);
      const error = apiError(data);
      // The API returns failed evaluations with 422; these documents remain readable client results.
      if (!res.ok && !(res.status === 422 && !error)) throw new VerdictError(res.status, error?.type ?? "http", error?.message ?? `HTTP ${res.status}`, error?.issues, error?.details);
      return { data: data as T, replayed: res.headers.get("Idempotency-Replayed") === "true" };
    } catch (error) {
      if (error instanceof VerdictError) throw error;
      throw new VerdictError(0, "network", `Verdict request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(t); }
  }

  /**
   * What an environment runs, for a service that evaluates locally: `await verdict.environment({ project, environment }).rubric("intent")`
   * resolves to `{ rubric, versionId, source }`. Keep one reader per environment: it holds the versions it received and
   * asks the server again only after `refreshMs`.
   */
  environment(options: EnvironmentOptions): EnvironmentReader {
    return environmentReader((path, headers, timeoutMs) => this.get(path, headers, timeoutMs), options);
  }

  /** A GET that gives up after `timeoutMs`, whether or not the fetch in use honours the abort signal. */
  private async get(path: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new VerdictError(408, "timeout", `no answer from ${this.baseUrl} within ${timeoutMs} ms`)); }, timeoutMs); });
    const asked = this.f(`${this.baseUrl}${path}`, { method: "GET", signal: ctrl.signal, headers: { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.org, ...headers } });
    // An abort also rejects the fetch; that rejection has been answered by `late` already.
    asked.catch(() => undefined);
    try { return await Promise.race([asked, late]); }
    catch (error) { throw error instanceof VerdictError ? error : new VerdictError(0, "network", `Verdict request failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { clearTimeout(timer); }
  }

  rubrics = {
    calibration: (id: string, options: { target?: number; buckets?: number; limit?: number } = {}) =>
      this.request<CalibrationReport>("GET", `/v1/rubrics/${encodeURIComponent(id)}/calibration?${new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
    create: (rubric: RubricInput | string) => typeof rubric === "string" ? this.request<Rubric & { id: string }>("POST", "/v1/rubrics", rubric, "application/yaml") : this.request<Rubric & { id: string }>("POST", "/v1/rubrics", rubric),
    validate: (rubric: RubricInput | string) => this.request<{ valid: boolean; rubric?: Rubric; error?: unknown }>("POST", "/v1/rubrics/validate", rubric, typeof rubric === "string" ? "application/yaml" : "application/json"),
    get: (id: string) => this.request<Rubric & { id: string }>("GET", `/v1/rubrics/${id}`),
    list: () => this.request<{ data: Array<Rubric & { id: string }> }>("GET", "/v1/rubrics"),
    update: (id: string, rubric: RubricInput) => this.request<Rubric & { id: string }>("PUT", `/v1/rubrics/${id}`, rubric),
    delete: (id: string) => this.request<void>("DELETE", `/v1/rubrics/${id}`),
  };

  evaluations = {
    retry: (id: string) => this.request<{ id: string; status: "queued"; url: string }>("POST", `/v1/evaluations/${encodeURIComponent(id)}/retry`),
    create: (params: EvaluateParams, opts: { idempotencyKey?: string } = {}) => this.request<EvaluationView>("POST", "/v1/evaluations", params, "application/json", keyHeaders(opts.idempotencyKey)),
    createIdempotent: async (params: EvaluateParams, key: string) => {
      const { data: evaluation, replayed } = await this.requestWithMeta<EvaluationView>("POST", "/v1/evaluations", params, "application/json", keyHeaders(key));
      return { evaluation, replayed };
    },
    /** Returns {id,status:"queued"}; poll with `get`, or use a webhook. */
    createAsync: (params: EvaluateParams, opts: { idempotencyKey?: string } = {}) => this.request<{ id: string; status: string; url: string }>("POST", "/v1/evaluations", { ...params, async: true }, "application/json", keyHeaders(opts.idempotencyKey)),
    get: (id: string, opts: { evidence?: boolean } = {}) => this.request<EvaluationView>("GET", `/v1/evaluations/${id}${opts.evidence ? "?evidence=true" : ""}`),
    list: (q: { rubric?: string; status?: string; limit?: number } = {}) => this.request<{ data: EvaluationView[] }>("GET", `/v1/evaluations?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
    submitScore: (id: string, s: { criterionId: string; raterId: string; score: number | string; rationale?: string; confidence?: number }) => this.request<EvaluationView>("POST", `/v1/evaluations/${id}/scores`, s),
    reaggregate: (id: string, aggregation: Partial<Aggregation>, persist = false) => this.request<EvaluationView>("POST", `/v1/evaluations/${id}/aggregate`, { aggregation, persist }),
    /** Poll until the evaluation leaves running/queued (does not wait for humans unless `waitForHumans`). */
    wait: async (id: string, opts: { intervalMs?: number; waitForHumans?: boolean; timeoutMs?: number } = {}) => {
      const start = Date.now();
      for (;;) {
        const ev = await this.evaluations.get(id);
        // why: human review can be unbounded, so polling stops at that state unless explicitly requested.
        const settled = ev.status === "completed" || ev.status === "failed" || (ev.status === "pending_human" && !opts.waitForHumans);
        if (settled) return ev;
        if (Date.now() - start > (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)) throw new VerdictError(408, "timeout", `evaluation ${id} still ${ev.status}`);
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS));
      }
    },
  };

  tasks = {
    list: (rater?: string) => this.request<{ data: Array<{ evaluationId: string; criterionId: string; raterId?: string; allowedRaters?: string[]; instructions?: string; rubric: string; subject?: string }> }>("GET", `/v1/tasks${rater ? `?rater=${encodeURIComponent(rater)}` : ""}`),
  };

  /** Hub sign-in: trade a GitHub token (device flow, run by the caller) for a hub API key bound to that account. */
  hub = {
    config: () => this.request<{ github: { clientId: string } | null; publishing: "github" | "tenant"; signIn?: BrowserSignIn }>("GET", "/v1/hub/config"),
    login: (githubToken: string) => this.request<{ apiKey: string; keyId: string; handle: string; tenantId: string }>("POST", "/v1/hub/login", { githubToken }),
    me: () => this.request<{ tenantId: string | null; handle: string | null; github: { id: number; login: string } | null }>("GET", "/v1/hub/me"),
    revokeKey: (id: string) => this.request<void>("DELETE", `/v1/hub/keys/${encodeURIComponent(id)}`),
    /** Public reads (no key): search cards, read one card at a version with its history, or one publication by id. */
    search: (q: { q?: string; domain?: string; locale?: string; type?: "score" | "noul" | "choice"; owner?: string; limit?: number } = {}) =>
      this.request<{ data: PublicListing[] }>("GET", `/v1/public/rubrics?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
    card: (owner: string, slug: string, opts: { version?: string } = {}) =>
      this.request<{ publication: PublicPublication; versions: PublicVersionEntry[] }>("GET", `/v1/public/rubrics/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}${opts.version ? `?version=${encodeURIComponent(opts.version)}` : ""}`),
    publication: (id: string) => this.request<PublicPublication>("GET", `/v1/public/publications/${encodeURIComponent(id)}`),
  };

  /** Publishing to the public hub: preview shows exactly the document publish would store. */
  publications = {
    preview: (request: PublicationRequest) => this.request<PublicationResult>("POST", "/v1/publications/preview", request),
    create: (request: PublicationRequest) => this.request<{ publication: Publication; warnings: PublicationIssue[]; created: boolean }>("POST", "/v1/publications", request),
    list: (opts: { limit?: number } = {}) => this.request<{ data: Publication[] }>("GET", `/v1/publications${opts.limit ? `?limit=${opts.limit}` : ""}`),
    withdraw: (id: string) => this.request<void>("DELETE", `/v1/publications/${encodeURIComponent(id)}`),
  };

  /** Projects group environments and rubric versions (the control plane). Deleting repeats the name as confirmation. */
  projects = {
    create: (name: string) => this.request<ProjectView>("POST", "/v1/projects", { name }),
    list: () => this.request<{ data: ProjectView[] }>("GET", "/v1/projects"),
    delete: (name: string) => this.request<void>("DELETE", `/v1/projects/${seg(name)}`, { confirm: name }),
    /** Pointer changes of a project, newest first. */
    history: (project: string, q: { environment?: string; name?: string; limit?: number } = {}) =>
      this.request<{ data: PromotionEventView[] }>("GET", `/v1/projects/${seg(project)}/history${query(q)}`),
  };

  /** Environments say which version of each rubric runs. A change names the version the caller saw (`expected`). */
  environments = {
    create: (project: string, name: string) => this.request<EnvironmentView>("POST", `/v1/projects/${seg(project)}/environments`, { name }),
    list: (project: string) => this.request<{ data: EnvironmentView[] }>("GET", `/v1/projects/${seg(project)}/environments`),
    get: (project: string, name: string) => this.request<EnvironmentView & { pointers: PointerView[] }>("GET", `/v1/projects/${seg(project)}/environments/${seg(name)}`),
    delete: (project: string, name: string) => this.request<void>("DELETE", `/v1/projects/${seg(project)}/environments/${seg(name)}`, { confirm: name }),
    /** Moves pointers, all or none. `versionId: null` removes a pointer. A stale `expected` throws `pointer_conflict`. */
    promote: (project: string, name: string, request: PromotionRequest) =>
      this.request<{ events: PromotionEventView[] }>("POST", `/v1/projects/${seg(project)}/environments/${seg(name)}/promotions`, request),
    /** Undoes the latest change of one pointer. */
    rollback: (project: string, name: string, request: RollbackRequest) =>
      this.request<{ event: PromotionEventView }>("POST", `/v1/projects/${seg(project)}/environments/${seg(name)}/rollbacks`, request),
  };

  /** Immutable rubric versions kept in a project under the name services ask for. */
  versions = {
    names: (project: string) => this.request<{ data: RubricName[] }>("GET", `/v1/projects/${seg(project)}/rubrics`),
    /** Uploads a frozen version; the server freezes the rubric again and refuses another id. */
    push: (project: string, name: string, version: VersionUpload) =>
      this.request<{ version: VersionView; created: boolean }>("POST", `/v1/projects/${seg(project)}/rubrics/${seg(name)}/versions`, version),
    list: (project: string, name: string, opts: { limit?: number } = {}) =>
      this.request<{ data: Array<Omit<VersionView, "rubric">> }>("GET", `/v1/projects/${seg(project)}/rubrics/${seg(name)}/versions${query(opts)}`),
    get: (project: string, name: string, id: string) => this.request<VersionView>("GET", `/v1/projects/${seg(project)}/rubrics/${seg(name)}/versions/${seg(id)}`),
    /** Refused with `in_use` while an environment points at the version. */
    delete: (project: string, name: string, id: string) => this.request<void>("DELETE", `/v1/projects/${seg(project)}/rubrics/${seg(name)}/versions/${seg(id)}`),
  };

  /** Numbers about runs made elsewhere (your CI). Build requests with `runReportRequest` / `comparisonReportRequest` from core: they copy counts only. */
  reports = {
    run: (project: string, request: RunReportRequest) => this.request<{ report: RunReportView; created: boolean }>("POST", `/v1/projects/${seg(project)}/reports/runs`, request),
    runs: (project: string, q: { name?: string; versionId?: string; dataset?: string; limit?: number } = {}) =>
      this.request<{ data: RunReportView[] }>("GET", `/v1/projects/${seg(project)}/reports/runs${query(q)}`),
    getRun: (project: string, runId: string) => this.request<RunReportView>("GET", `/v1/projects/${seg(project)}/reports/runs/${seg(runId)}`),
    /** Both runs must have been reported first. */
    comparison: (project: string, request: ComparisonReportRequest) =>
      this.request<{ report: ComparisonReportView; created: boolean }>("POST", `/v1/projects/${seg(project)}/reports/comparisons`, request),
    comparisons: (project: string, q: { name?: string; head?: string; limit?: number } = {}) =>
      this.request<{ data: ComparisonReportView[] }>("GET", `/v1/projects/${seg(project)}/reports/comparisons${query(q)}`),
  };

  batches = {
    create: (params: BatchParams, opts: { idempotencyKey?: string } = {}) =>
      this.request<BatchResult>("POST", "/v1/batches", params, "application/json", keyHeaders(opts.idempotencyKey)),
    createIdempotent: async (params: BatchParams, key: string) => {
      const { data, replayed } = await this.requestWithMeta<BatchResult>("POST", "/v1/batches", params, "application/json", keyHeaders(key));
      return { ...data, replayed };
    },
  };
}

export default Verdict;

export interface BatchParams { rubric: string | RubricInput; subjects: Subject[]; metadata?: Record<string, unknown>; webhook?: string }
export interface BatchResult { ranking: Array<{ rank: number; evaluationId: string; subject: string; score?: number; grade?: string; passed?: boolean; status: string }>; evaluations: EvaluationView[] }
const seg = encodeURIComponent;
function query(q: Record<string, string | number | undefined>): string {
  const entries = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
}
function keyHeaders(key?: string): Record<string, string> { return key === undefined ? {} : { "Idempotency-Key": key }; }

async function responseBody(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch (cause) {
    const type = response.ok ? "invalid_response" : "http";
    throw new VerdictError(response.status, type, response.ok ? "Verdict returned invalid JSON" : `HTTP ${response.status}`, { cause: cause instanceof Error ? cause.message : String(cause) });
  }
}

function apiError(data: unknown): { type: string; message: string; issues?: unknown; details: Record<string, unknown> } | undefined {
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  const error = data.error;
  if (!error || typeof error !== "object" || !("type" in error) || !("message" in error)) return undefined;
  if (typeof error.type !== "string" || typeof error.message !== "string") return undefined;
  return { type: error.type, message: error.message, issues: "issues" in error ? error.issues : undefined, details: { ...error } };
}
