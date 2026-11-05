import type { Rubric } from "../schema/rubric.js";
import type { Evaluation } from "../schema/evaluation.js";

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

const scoped = <T extends { tenantId?: string }>(x: T | undefined, tenantId?: string) => (x && (tenantId === undefined || x.tenantId === tenantId) ? x : undefined);

export class MemoryStore implements Store {
  private idempotency = new Map<string, IdempotencyRecord>();
  async putIdempotency(r: IdempotencyRecord) { this.idempotency.set(JSON.stringify([r.tenantId ?? "", r.key]), r); }
  async getIdempotency(tenantId: string | undefined, key: string) { return this.idempotency.get(JSON.stringify([tenantId ?? "", key])); }
  rubrics = new Map<string, StoredRubric>();
  evaluations = new Map<string, Evaluation>();
  async putRubric(r: StoredRubric) { this.rubrics.set(r.id, r); }
  async getRubric(id: string, tenantId?: string) { return scoped(this.rubrics.get(id), tenantId); }
  async listRubrics(o: ListOptions = {}) {
    return [...this.rubrics.values()].filter((r) => o.tenantId === undefined || r.tenantId === o.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, o.limit ?? 100);
  }
  async deleteRubric(id: string, tenantId?: string) { return scoped(this.rubrics.get(id), tenantId) ? this.rubrics.delete(id) : false; }
  async putEvaluation(e: Evaluation) { this.evaluations.set(e.id, e); }
  async getEvaluation(id: string, tenantId?: string) { return scoped(this.evaluations.get(id), tenantId); }
  async listEvaluations(o: ListOptions = {}) {
    return [...this.evaluations.values()]
      .filter((e) => (o.tenantId === undefined || e.tenantId === o.tenantId) && (!o.rubricId || e.rubricId === o.rubricId) && (!o.status || e.status === o.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, o.limit ?? 100);
  }
}

/** JSON-files-on-disk store. Good for the CLI and single-node deployments. */
export class FileStore implements Store {
  constructor(private dir: string) {}
  private async keyId(tenantId: string | undefined, key: string) {
    const { fingerprint } = await import("../idempotency.js");
    return fingerprint([tenantId ?? "", key]);
  }
  async putIdempotency(r: IdempotencyRecord) { await this.write("idempotency", await this.keyId(r.tenantId, r.key), r); }
  async getIdempotency(tenantId: string | undefined, key: string) { return this.read<IdempotencyRecord>("idempotency", await this.keyId(tenantId, key)); }
  async reserveIdempotency(record: IdempotencyRecord, evaluations: Evaluation[]): Promise<boolean> {
    const { mkdir, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(this.dir, "idempotency"), { recursive: true });
    const lock = join(this.dir, "idempotency", `${await this.keyId(record.tenantId, record.key)}.lock`);
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    try {
      const existing = await this.getIdempotency(record.tenantId, record.key);
      if (existing && Date.parse(existing.expiresAt) > Date.now()) {
        const ids = existing.targetType === "evaluation" ? [existing.targetId!] : existing.evaluationIds!;
        const targets = await Promise.all(ids.map(id => this.getEvaluation(id, record.tenantId)));
        if (targets.every(Boolean)) return false;
      }
      for (const evaluation of evaluations) await this.putEvaluation(evaluation);
      await this.putIdempotency(record);
      return true;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async read<T>(kind: string, id: string): Promise<T | undefined> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try { return JSON.parse(await readFile(join(this.dir, kind, `${id}.json`), "utf8")) as T; } catch { return undefined; }
  }
  private async write(kind: string, id: string, v: unknown) {
    const { mkdir, writeFile, rename, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(this.dir, kind), { recursive: true });
    const temporary = join(this.dir, kind, `${id}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(v, null, 2));
      await rename(temporary, join(this.dir, kind, `${id}.json`));
    } finally { await rm(temporary, { force: true }); }
  }
  private async all<T>(kind: string): Promise<T[]> {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let files: string[] = [];
    try { files = await readdir(join(this.dir, kind)); } catch { return []; }
    const items = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => this.read<T>(kind, f.slice(0, -5))));
    return items.filter((x) => x !== undefined) as T[];
  }
  async putRubric(r: StoredRubric) { await this.write("rubrics", r.id, r); }
  async getRubric(id: string, tenantId?: string) { return scoped(await this.read<StoredRubric>("rubrics", id), tenantId); }
  async listRubrics(o: ListOptions = {}) { return (await this.all<StoredRubric>("rubrics")).filter((r) => o.tenantId === undefined || r.tenantId === o.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, o.limit ?? 100); }
  async deleteRubric(id: string, tenantId?: string) {
    if (!(await this.getRubric(id, tenantId))) return false;
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(this.dir, "rubrics", `${id}.json`), { force: true });
    return true;
  }
  async putEvaluation(e: Evaluation) { await this.write("evaluations", e.id, e); }
  async getEvaluation(id: string, tenantId?: string) { return scoped(await this.read<Evaluation>("evaluations", id), tenantId); }
  async listEvaluations(o: ListOptions = {}) {
    return (await this.all<Evaluation>("evaluations"))
      .filter((e) => (o.tenantId === undefined || e.tenantId === o.tenantId) && (!o.rubricId || e.rubricId === o.rubricId) && (!o.status || e.status === o.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, o.limit ?? 100);
  }
}
