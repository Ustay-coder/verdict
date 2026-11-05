import type { CalibrationReport, Aggregation, Evaluation, Input, Rubric, RubricInput, Subject } from "@verdict/core";

export interface VerdictOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Request timeout in ms (sync evaluations can take a while). Default 10 min. */
  timeoutMs?: number;
}

export class VerdictError extends Error {
  constructor(public status: number, public type: string, message: string, public issues?: unknown) { super(message); }
}

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

  constructor(opts: VerdictOptions = {}) {
    this.apiKey = opts.apiKey ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_API_KEY;
    this.baseUrl = (opts.baseUrl ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
    this.f = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
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
        headers: { "content-type": contentType, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      if (res.status === 204) return { data: undefined as T, replayed: res.headers.get("Idempotency-Replayed") === "true" };
      const data = (await res.json().catch(() => ({}))) as { error?: { type: string; message: string; issues?: unknown } };
      if (!res.ok && !(res.status === 422 && !data.error)) throw new VerdictError(res.status, data.error?.type ?? "http", data.error?.message ?? `HTTP ${res.status}`, data.error?.issues);
      return { data: data as T, replayed: res.headers.get("Idempotency-Replayed") === "true" };
    } finally { clearTimeout(t); }
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
        const settled = ev.status === "completed" || ev.status === "failed" || (ev.status === "pending_human" && !opts.waitForHumans);
        if (settled) return ev;
        if (Date.now() - start > (opts.timeoutMs ?? 600_000)) throw new VerdictError(408, "timeout", `evaluation ${id} still ${ev.status}`);
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500));
      }
    },
  };

  tasks = {
    list: (rater?: string) => this.request<{ data: Array<{ evaluationId: string; criterionId: string; raterId?: string; allowedRaters?: string[]; instructions?: string; rubric: string; subject?: string }> }>("GET", `/v1/tasks${rater ? `?rater=${encodeURIComponent(rater)}` : ""}`),
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
function keyHeaders(key?: string): Record<string, string> { return key === undefined ? {} : { "Idempotency-Key": key }; }
