/**
 * Immutable dataset versions: a fixed list of cases with expected labels. Inputs and labels hash separately, so a
 * label-only change keeps `casesHash` — the signal that stored runs can be re-scored instead of re-run — while any
 * input change forces a new run. Case order does not affect either hash.
 */
import { labelCases, type GoldItem, type LabelledCase } from "../agreement.js";
import { fingerprint } from "../idempotency.js";
import type { Input } from "../schema/subject.js";

export interface DatasetVersion {
  id: string;
  tenantId?: string;
  name?: string;
  /** Hash of each case's id and inputs (file inputs by content digest when a reader is supplied, else by path). */
  casesHash: string;
  /** Hash of each case's id, labels and label source. */
  labelsHash: string;
  cases: LabelledCase[];
  createdAt: string;
}

export interface DatasetOptions {
  name?: string;
  tenantId?: string;
  now?: () => number;
  /** Reads `file` inputs given by path so their content, not just the path, identifies the case. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

const ID_CHARS = 20;

/** Freezes gold cases into a dataset version. Labels are not checked against any rubric here; runs do that. */
export async function createDatasetVersion(items: GoldItem[], opts: DatasetOptions = {}): Promise<DatasetVersion> {
  const cases = labelCases(items);
  const byId = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inputs = await Promise.all(byId.map(async (c) => ({ id: c.id, inputs: await Promise.all(c.inputs.map((i) => inputIdentity(i, opts.readFile))) })));
  const [casesHash, labelsHash] = await Promise.all([
    fingerprint(inputs),
    fingerprint(byId.map((c) => ({ id: c.id, human: c.human, labelSource: c.labelSource ?? null }))),
  ]);
  const id = `dsv_${(await fingerprint([casesHash, labelsHash])).slice(0, ID_CHARS)}`;
  return { id, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}), ...(opts.name ? { name: opts.name } : {}), casesHash, labelsHash, cases, createdAt: new Date((opts.now ?? Date.now)()).toISOString() };
}

/** Replaces a file path with a digest of its bytes when a reader is available; everything else is hashed as given. */
async function inputIdentity(input: Input, readFile?: DatasetOptions["readFile"]): Promise<unknown> {
  if (input.type !== "file" || !input.path || !readFile) return input;
  // Copy into a plain ArrayBuffer: Web Crypto does not accept views over shared buffers.
  const bytes = new Uint8Array(await readFile(input.path));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const { path: _path, ...rest } = input;
  return { ...rest, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") };
}
