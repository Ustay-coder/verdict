import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Rubric } from "../schema/rubric.js";
import type { Evaluation } from "../schema/evaluation.js";

export interface StoredRubric extends Rubric { id: string; tenantId?: string; createdAt: string; updatedAt: string }

export interface ListOptions { tenantId?: string; limit?: number; rubricId?: string; status?: string }

/** Persistence boundary. Implement this for Postgres / Cloudflare D1 / KV / Redis etc. */
export interface Store {
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
  private async read<T>(kind: string, id: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.dir, kind, `${id}.json`), "utf8")) as T; } catch { return undefined; }
  }
  private async write(kind: string, id: string, v: unknown) {
    await mkdir(join(this.dir, kind), { recursive: true });
    await writeFile(join(this.dir, kind, `${id}.json`), JSON.stringify(v, null, 2));
  }
  private async all<T>(kind: string): Promise<T[]> {
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
