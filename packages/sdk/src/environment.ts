/**
 * Reads which rubric versions an environment runs, for a service that evaluates on its own machine with its own model
 * keys (docs/design/control-plane.md §6). The whole environment arrives in one answer and is kept; after `refreshMs`
 * the next call asks the server again — no timer runs, so this works in Workers. A check that fails or is slow never
 * stops the service: it carries on with the versions it holds and says so in `source`.
 */
import type { Rubric, RubricInput } from "@verdict-ai/core";

import { VerdictError } from "./errors.js";

export interface EnvironmentOptions {
  project: string;
  environment: string;
  /** How long an answer is used before the next call asks the server again. Default 60 s. */
  refreshMs?: number;
  /** How long a check may take before the versions already held are used instead. Default 2 s. */
  timeoutMs?: number;
  /** Rubrics to run, by name, while the server has given none: at a cold start it cannot answer, or before a first promotion. */
  fallback?: Record<string, RubricInput>;
  /** Told about every failed check. The reader carries on with what it holds. */
  onError?: (error: unknown) => void;
  /** Clock (tests). */
  now?: () => number;
}

export interface EnvironmentRubric {
  rubric: Rubric;
  /** The version that will run — log it with each judgment. */
  versionId: string;
  /** `server`: confirmed by the last check. `stale`: the last check failed, this is what was held. `fallback`: the rubric given in code. */
  source: "server" | "stale" | "fallback";
}

export interface EnvironmentReader {
  /** The rubric this environment runs under `name`. Throws only when there is nothing to run: no answer yet and no fallback. */
  rubric(name: string): Promise<EnvironmentRubric>;
  /** Asks the server now, whatever `refreshMs` says. Resolves to whether the check succeeded. */
  refresh(): Promise<boolean>;
}

/** GET `path` with these headers, giving up after `timeoutMs`. */
export type EnvironmentTransport = (path: string, headers: Record<string, string>, timeoutMs: number) => Promise<Response>;

type Kept = Pick<EnvironmentRubric, "rubric" | "versionId">;
interface Answer { pointers: Array<{ name: string; versionId: string; rubric: unknown }> }

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;

/** Freezes a document the way the server does; loaded on first use so clients that never read environments stay small. */
async function freeze(rubric: unknown): Promise<Kept> {
  const { freezeRubric } = await import("@verdict-ai/core");
  const version = await freezeRubric(rubric);
  return { rubric: version.rubric, versionId: version.id };
}

/** Every document is used only if it freezes to the id the server named: a changed or cut-off answer is refused whole. */
async function verified(answer: Answer): Promise<Map<string, Kept>> {
  const kept = new Map<string, Kept>();
  for (const pointer of answer.pointers ?? []) {
    const frozen = await freeze(pointer.rubric);
    if (frozen.versionId !== pointer.versionId) throw new VerdictError(502, "integrity", `${pointer.name}: the server named ${pointer.versionId}, but the rubric it sent freezes to ${frozen.versionId}`);
    kept.set(pointer.name, frozen);
  }
  return kept;
}

async function failure(res: Response): Promise<VerdictError> {
  const body = await res.json().catch(() => undefined) as { error?: { type?: string; message?: string } } | undefined;
  return new VerdictError(res.status, body?.error?.type ?? "http", body?.error?.message ?? `HTTP ${res.status}`);
}

export function environmentReader(send: EnvironmentTransport, options: EnvironmentOptions): EnvironmentReader {
  const { project, environment, refreshMs = DEFAULT_REFRESH_MS, timeoutMs = DEFAULT_TIMEOUT_MS, fallback = {}, onError, now = () => Date.now() } = options;
  const path = `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}?include=rubrics`;
  const spares = new Map<string, Promise<Kept>>();
  let held: { etag: string | null; rubrics: Map<string, Kept> } | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY, confirmed = false, lastError: unknown, checking: Promise<void> | undefined;

  const check = async () => {
    try {
      const res = await send(path, held?.etag ? { "if-none-match": held.etag } : {}, timeoutMs);
      if (!(res.status === 304 && held)) {
        if (!res.ok) throw await failure(res);
        held = { etag: res.headers.get("etag"), rubrics: await verified(await res.json() as Answer) };
      }
      confirmed = true;
    } catch (error) {
      confirmed = false;
      lastError = error;
      onError?.(error);
    } finally { checkedAt = now(); }
  };
  // Calls that arrive during a check wait for that one check.
  const checked = () => (checking ??= check().finally(() => { checking = undefined; }));
  const spare = (name: string) => (name in fallback ? spares.get(name) ?? spares.set(name, freeze(fallback[name])).get(name)! : undefined);

  return {
    async rubric(name) {
      // With nothing to run for this name, waiting out the interval would only delay the error.
      const nothingToRun = !held && !(name in fallback);
      if (now() - checkedAt >= refreshMs || nothingToRun) await checked();
      const kept = held?.rubrics.get(name);
      if (kept) return { ...kept, source: confirmed ? "server" : "stale" };
      const given = await spare(name);
      if (given) return { ...given, source: "fallback" };
      if (held) throw new VerdictError(404, "not_promoted", `${environment} in ${project} does not run ${name}, and no fallback rubric was given for it`);
      const why = lastError instanceof Error ? lastError.message : String(lastError);
      throw new VerdictError(lastError instanceof VerdictError ? lastError.status : 0, "environment_unavailable", `could not read ${environment} in ${project} and no fallback rubric was given for ${name}: ${why}`);
    },
    async refresh() {
      await checked();
      return confirmed;
    },
  };
}
