/**
 * Tenant-scoped reads prevent cross-tenant lookup; file reservations publish targets before releasing locks.
 */
import { FileAccessError } from "../file-error.js";
import type { Rubric } from "../schema/rubric.js";
import type { Evaluation } from "../schema/evaluation.js";
import type { DatasetVersion } from "../versions/dataset.js";
import type { RubricVersion } from "../versions/rubric-version.js";
import type { Run } from "../versions/run.js";
import type { VersionStore } from "../versions/store.js";
import type { Publication } from "../hub/publication.js";
import { matchesPublication, PUBLICATION_LIST_LIMIT, type Publisher, type PublisherStore, type PublicationQuery, type PublicationStore } from "../hub/store.js";
import { DocumentControlStore, memoryControlDocs } from "../control/documents.js";
import type { ControlStore } from "../control/store.js";

export interface StoredRubric extends Rubric { id: string; tenantId?: string; createdAt: string; updatedAt: string }

export interface ListOptions { tenantId?: string; limit?: number; rubricId?: string; status?: string }

/** Persistence boundary. Implement this for Postgres / Cloudflare D1 / KV / Redis etc. */
export interface IdempotencyRecord {
  tenantId?: string;
  key: string;
  fingerprint: string;
  targetType: "evaluation" | "batch";
  targetId?: string;
  evaluationIds?: string[];
  createdAt: string;
  expiresAt: string;
}

export interface Store {
  /** Atomically reserve a key and its initial documents. False means another caller owns it. */
  reserveIdempotency?(record: IdempotencyRecord, evaluations: Evaluation[]): Promise<boolean>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
  getIdempotency(tenantId: string | undefined, key: string): Promise<IdempotencyRecord | undefined>;
  putRubric(r: StoredRubric): Promise<void>;
  getRubric(id: string, tenantId?: string): Promise<StoredRubric | undefined>;
  listRubrics(o?: ListOptions): Promise<StoredRubric[]>;
  deleteRubric(id: string, tenantId?: string): Promise<boolean>;
  putEvaluation(e: Evaluation): Promise<void>;
  getEvaluation(id: string, tenantId?: string): Promise<Evaluation | undefined>;
  listEvaluations(o?: ListOptions): Promise<Evaluation[]>;
}

const RESERVATION_POLL_MS = 5;

// why: undefined tenant is the local single-tenant API; supplied tenants must match before returning records.
const scoped = <T extends { tenantId?: string }>(x: T | undefined, tenantId?: string) => (x && (tenantId === undefined || x.tenantId === tenantId) ? x : undefined);

/** Stores records in memory; absent or out-of-scope lookups return undefined. */
export class MemoryStore implements Store, VersionStore, PublicationStore, PublisherStore {
  private idempotency = new Map<string, IdempotencyRecord>();
  async putIdempotency(r: IdempotencyRecord) { this.idempotency.set(JSON.stringify([r.tenantId ?? "", r.key]), r); }
  async getIdempotency(tenantId: string | undefined, key: string) { return this.idempotency.get(JSON.stringify([tenantId ?? "", key])); }
  rubrics = new Map<string, StoredRubric>();
  evaluations = new Map<string, Evaluation>();
  async putRubric(r: StoredRubric) { this.rubrics.set(r.id, r); }
  async getRubric(id: string, tenantId?: string) { return scoped(this.rubrics.get(id), tenantId); }
  async listRubrics(o: ListOptions = {}) {
    return recentRecords([...this.rubrics.values()], o);
  }
  async deleteRubric(id: string, tenantId?: string) { return scoped(this.rubrics.get(id), tenantId) ? this.rubrics.delete(id) : false; }
  async putEvaluation(e: Evaluation) { this.evaluations.set(e.id, e); }
  async getEvaluation(id: string, tenantId?: string) { return scoped(this.evaluations.get(id), tenantId); }
  async listEvaluations(o: ListOptions = {}) {
    return recentEvaluations([...this.evaluations.values()], o);
  }
  rubricVersions = new Map<string, RubricVersion>();
  datasetVersions = new Map<string, DatasetVersion>();
  runs = new Map<string, Run>();
  async putRubricVersion(v: RubricVersion) { this.rubricVersions.set(v.id, v); }
  async getRubricVersion(id: string, tenantId?: string) { return scoped(this.rubricVersions.get(id), tenantId); }
  async listRubricVersions(o: VersionListOptions = {}) { return recentVersions([...this.rubricVersions.values()], o); }
  async putDatasetVersion(d: DatasetVersion) { this.datasetVersions.set(d.id, d); }
  async getDatasetVersion(id: string, tenantId?: string) { return scoped(this.datasetVersions.get(id), tenantId); }
  async putRun(r: Run) { this.runs.set(r.id, r); }
  async getRun(id: string, tenantId?: string) { return scoped(this.runs.get(id), tenantId); }
  async listRuns(o: RunListOptions = {}) { return recentRuns([...this.runs.values()], o); }
  publications = new Map<string, Publication>();
  async putPublication(p: Publication) { this.publications.set(p.id, p); }
  async getPublication(id: string) { return this.publications.get(id); }
  async listPublications(q: PublicationQuery = {}) { return newestPublications([...this.publications.values()], q); }
  async withdrawPublication(id: string, tenantId: string | undefined, at: string) {
    const p = this.publications.get(id);
    if (!p || p.tenantId !== tenantId) return false;
    this.publications.set(id, { ...p, withdrawnAt: p.withdrawnAt ?? at });
    return true;
  }
  publishers = new Map<string, Publisher>();
  async putPublisher(p: Publisher) { this.publishers.set(p.tenantId, p); }
  async getPublisher(tenantId: string) { return this.publishers.get(tenantId); }
  /** Projects, environments, pointers and reports (docs/design/control-plane.md). */
  readonly control: ControlStore = new DocumentControlStore(memoryControlDocs());
}

type FileSystem = Pick<typeof import("node:fs/promises"), "readFile" | "writeFile" | "mkdir" | "readdir" | "rename" | "rm">;

/** JSON-files-on-disk store. Good for the CLI and single-node deployments. */
export class FileStore implements Store, VersionStore, PublicationStore, PublisherStore {
  /** Projects, environments, pointers and reports (docs/design/control-plane.md), one JSON file per document. */
  readonly control: ControlStore;
  constructor(private dir: string, private fs?: FileSystem) {
    this.control = new DocumentControlStore({
      get: (kind, id) => this.read(kind, id), put: (kind, id, value) => this.write(kind, id, value),
      remove: (kind, id) => this.remove(kind, id), all: (kind) => this.all(kind),
      exclusive: (work) => this.locked("control.lock", work),
    });
  }
  private filesystem(): Promise<FileSystem> { return this.fs ? Promise.resolve(this.fs) : import("node:fs/promises"); }
  private async keyId(tenantId: string | undefined, key: string) {
    const { fingerprint } = await import("../idempotency.js");
    return fingerprint([tenantId ?? "", key]);
  }
  async putIdempotency(r: IdempotencyRecord) { await this.write("idempotency", await this.keyId(r.tenantId, r.key), r); }
  async getIdempotency(tenantId: string | undefined, key: string) { return this.read<IdempotencyRecord>("idempotency", await this.keyId(tenantId, key)); }
  async reserveIdempotency(record: IdempotencyRecord, evaluations: Evaluation[]): Promise<boolean> {
    const { mkdir, rm } = await this.filesystem();
    const { join } = await import("node:path");
    await mkdir(join(this.dir, "idempotency"), { recursive: true });
    const lock = join(this.dir, "idempotency", `${await this.keyId(record.tenantId, record.key)}.lock`);
    await this.acquire(lock);
    try {
      // Compare in the reservation clock domain so injected engine time also controls durable expiry.
      const existing = await this.getIdempotency(record.tenantId, record.key);
      if (existing && Date.parse(existing.expiresAt) > Date.parse(record.createdAt)) {
        const ids = existing.targetType === "evaluation" ? [existing.targetId!] : existing.evaluationIds!;
        const targets = await Promise.all(ids.map(id => this.getEvaluation(id, record.tenantId)));
        if (targets.every(Boolean)) return false;
      }
      for (const evaluation of evaluations) await this.putEvaluation(evaluation);
      await this.putIdempotency(record);
      return true;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async acquire(lock: string) {
    const { mkdir } = await this.filesystem();
    for (; ;) {
      try { await mkdir(lock); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // why: mkdir is the cross-process exclusion primitive; brief polling yields while the owner publishes targets.
        await new Promise(resolve => setTimeout(resolve, RESERVATION_POLL_MS));
      }
    }
  }
  /** Runs `work` while holding a lock directory under the data directory. */
  private async locked<T>(name: string, work: () => Promise<T>): Promise<T> {
    const { mkdir, rm } = await this.filesystem();
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    const lock = join(this.dir, name);
    await this.acquire(lock);
    try { return await work(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async remove(kind: string, id: string) {
    const { rm } = await this.filesystem();
    const { join } = await import("node:path");
    const path = join(this.dir, kind, `${id}.json`);
    try { await rm(path, { force: true }); }
    catch (cause) { throw new FileAccessError(path, "delete", cause); }
  }
  private async read<T>(kind: string, id: string): Promise<T | undefined> {
    const { readFile } = await this.filesystem();
    const { join } = await import("node:path");
    try { return JSON.parse(await readFile(join(this.dir, kind, `${id}.json`), "utf8")) as T; } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new SyntaxError(`Corrupt JSON in ${kind}/${id}: ${error.message}`, { cause: error });
      throw new FileAccessError(join(this.dir, kind, `${id}.json`), "read", error);
    }
  }
  private async write(kind: string, id: string, v: object) {
    const { mkdir, writeFile, rename, rm } = await this.filesystem();
    const { join } = await import("node:path");
    const temporary = join(this.dir, kind, `${id}.${crypto.randomUUID()}.tmp`);
    try {
      await mkdir(join(this.dir, kind), { recursive: true });
      await writeFile(temporary, JSON.stringify(v, null, 2));
      // why: rename publishes complete JSON atomically so concurrent readers never observe a partial write.
      await rename(temporary, join(this.dir, kind, `${id}.json`));
    } catch (cause) { throw new FileAccessError(join(this.dir, kind, `${id}.json`), "write", cause); }
    finally {
      try { await rm(temporary, { force: true }); }
      catch (cause) { throw new FileAccessError(temporary, "remove temporary document", cause); }
    }
  }
  private async all<T>(kind: string): Promise<T[]> {
    const { readdir } = await this.filesystem();
    const { join } = await import("node:path");
    let files: string[] = [];
    try { files = await readdir(join(this.dir, kind)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new FileAccessError(join(this.dir, kind), "list", error);
    }
    // why: temporary writes and reservation locks are not documents and must not appear in listings.
    const items = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => this.read<T>(kind, f.slice(0, -5))));
    return items.filter((x): x is Awaited<T> => x !== undefined);
  }
  async putRubric(r: StoredRubric) { await this.write("rubrics", r.id, r); }
  async getRubric(id: string, tenantId?: string) { return scoped(await this.read<StoredRubric>("rubrics", id), tenantId); }
  async listRubrics(o: ListOptions = {}) { return recentRecords(await this.all<StoredRubric>("rubrics"), o); }
  async deleteRubric(id: string, tenantId?: string) {
    if (!(await this.getRubric(id, tenantId))) return false;
    const { rm } = await this.filesystem();
    const { join } = await import("node:path");
    const path = join(this.dir, "rubrics", `${id}.json`);
    try { await rm(path, { force: true }); }
    catch (cause) { throw new FileAccessError(path, "delete rubric", cause); }
    return true;
  }
  async putEvaluation(e: Evaluation) { await this.write("evaluations", e.id, e); }
  async getEvaluation(id: string, tenantId?: string) { return scoped(await this.read<Evaluation>("evaluations", id), tenantId); }
  async listEvaluations(o: ListOptions = {}) {
    return recentEvaluations(await this.all<Evaluation>("evaluations"), o);
  }
  async putRubricVersion(v: RubricVersion) { await this.write("rubric-versions", v.id, v); }
  async getRubricVersion(id: string, tenantId?: string) { return scoped(await this.read<RubricVersion>("rubric-versions", id), tenantId); }
  async listRubricVersions(o: VersionListOptions = {}) { return recentVersions(await this.all<RubricVersion>("rubric-versions"), o); }
  async putDatasetVersion(d: DatasetVersion) { await this.write("datasets", d.id, d); }
  async getDatasetVersion(id: string, tenantId?: string) { return scoped(await this.read<DatasetVersion>("datasets", id), tenantId); }
  async putRun(r: Run) { await this.write("runs", r.id, r); }
  async getRun(id: string, tenantId?: string) { return scoped(await this.read<Run>("runs", id), tenantId); }
  async listRuns(o: RunListOptions = {}) { return recentRuns(await this.all<Run>("runs"), o); }
  async putPublication(p: Publication) { await this.write("publications", p.id, p); }
  async getPublication(id: string) { return this.read<Publication>("publications", id); }
  async listPublications(q: PublicationQuery = {}) { return newestPublications(await this.all<Publication>("publications"), q); }
  async withdrawPublication(id: string, tenantId: string | undefined, at: string) {
    const p = await this.getPublication(id);
    if (!p || p.tenantId !== tenantId) return false;
    await this.putPublication({ ...p, withdrawnAt: p.withdrawnAt ?? at });
    return true;
  }
  // Tenant ids such as `gh:123` are not safe file names; the file is named by a hash of the id.
  async putPublisher(p: Publisher) { await this.write("publishers", await this.keyId(undefined, p.tenantId), p); }
  async getPublisher(tenantId: string) { return this.read<Publisher>("publishers", await this.keyId(undefined, tenantId)); }
}


// Memory and file listings share ordering and tenant filtering so adapter choice cannot change results.
function recentRecords<T extends { tenantId?: string; createdAt: string }>(records: T[], options: ListOptions): T[] {
  return records.filter(record => scoped(record, options.tenantId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, options.limit ?? 100);
}

function recentEvaluations(records: Evaluation[], options: ListOptions): Evaluation[] {
  return recentRecords(records.filter(record => (!options.rubricId || record.rubricId === options.rubricId) && (!options.status || record.status === options.status)), options);
}

type VersionListOptions = { tenantId?: string; rubricKey?: string; limit?: number };
type RunListOptions = { tenantId?: string; rubricVersionId?: string; datasetVersionId?: string; limit?: number };

function recentVersions(records: RubricVersion[], o: VersionListOptions): RubricVersion[] {
  return recentRecords(records.filter((v) => !o.rubricKey || v.rubricKey === o.rubricKey), o);
}

function recentRuns(records: Run[], o: RunListOptions): Run[] {
  const matching = records.filter((r) => (!o.rubricVersionId || r.rubricVersionId === o.rubricVersionId) && (!o.datasetVersionId || r.datasetVersionId === o.datasetVersionId));
  return recentRecords(matching.map((r) => ({ ...r, createdAt: r.startedAt })), o).map(({ createdAt: _c, ...r }) => r as Run);
}

function newestPublications(records: Publication[], q: PublicationQuery): Publication[] {
  return records.filter((p) => matchesPublication(p, q)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? PUBLICATION_LIST_LIMIT);
}
