/**
 * Owns engine dependencies and stored rubric resolution.
 * Workers require a bound fetch call; injected clocks and IDs keep lifecycle tests deterministic.
 */
import { type IngestOptions } from "../ingest/index.js";
import { type Queue } from "../queue.js";
import type { Evaluation } from "../schema/evaluation.js";
import { parseRubric, type Rubric } from "../schema/rubric.js";
import { MemoryStore, type Store, type StoredRubric } from "../store/index.js";
import { deliverWebhook } from "./webhook.js";

import { NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import { type EngineEvent, type EngineOptions, type EvaluateRequest } from "./types.js";

// Keep retries bounded during outages; keys remain replayable for a full day by default.
const MAX_RETRY_DELAY_MS = 300_000;
const RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000;

/** Owns engine dependencies; rubric operations reject validation, missing-record and storage failures. */
export class EngineBase {
  protected now: () => number;
  protected makeId: (prefix: string) => string;
  readonly queue?: Queue;
  protected maxAttempts: number;
  protected backoffMs: (attempt: number) => number;
  readonly store: Store;
  protected idempotencyTtlMs: number;
  protected env: (n: string) => string | undefined;
  protected fetchImpl: typeof fetch;
  protected ingestOptions: IngestOptions;
  protected concurrency: number;
  protected rateLimitWait?: (ms: number) => Promise<void>;
  protected webhookSecret?: string;
  protected onEvent?: (e: EngineEvent) => void;

  constructor(opts: EngineOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.makeId = opts.newId ?? (prefix => newId(prefix, this.now(), opts.random?.()));
    this.queue = opts.queue;
    this.maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 5);
    this.backoffMs = opts.retry?.backoffMs ?? (attempt => Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.8 + (opts.random ?? Math.random)() * 0.4)));
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.store = opts.store ?? new MemoryStore();
    this.env = opts.env ?? ((n) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[n]);
    // Never store the bare global: Workers throw "Illegal invocation" when fetch is called with a foreign `this`.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.ingestOptions = { fetch: this.fetchImpl, ...opts.ingest };
    this.concurrency = opts.concurrency ?? 8;
    this.rateLimitWait = opts.rateLimitWait;
    this.webhookSecret = opts.webhookSecret ?? this.env("VERDICT_WEBHOOK_SECRET");
    this.onEvent = opts.onEvent;
  }

  async createRubric(input: unknown, tenantId?: string): Promise<StoredRubric> {
    const rubric = parseRubric(input);
    const now = new Date(this.now()).toISOString();
    const stored: StoredRubric = { ...rubric, id: rubric.id ?? this.makeId("rub"), tenantId, createdAt: now, updatedAt: now };
    await this.store.putRubric(stored);
    return stored;
  }

  async updateRubric(id: string, input: unknown, tenantId?: string): Promise<StoredRubric> {
    const existing = await this.store.getRubric(id, tenantId);
    if (!existing) throw new NotFoundError(`rubric ${id} not found`);
    const rubric = parseRubric({ ...(input as object), id });
    const stored: StoredRubric = { ...rubric, id, tenantId, createdAt: existing.createdAt, updatedAt: new Date(this.now()).toISOString() };
    await this.store.putRubric(stored);
    return stored;
  }

  async resolveRubric(ref: EvaluateRequest["rubric"], tenantId?: string): Promise<{ rubric: Rubric; rubricId?: string }> {
    if (typeof ref === "string") {
      const r = await this.store.getRubric(ref, tenantId);
      if (!r) throw new NotFoundError(`rubric ${ref} not found`);
      return { rubric: r, rubricId: r.id };
    }
    const rubric = parseRubric(ref);
    return { rubric, rubricId: rubric.id };
  }

  protected deliverWebhook(ev: Evaluation) {
    return deliverWebhook(ev, this.fetchImpl, this.webhookSecret, this.onEvent);
  }
}
