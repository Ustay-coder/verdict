/**
 * 검토 앱의 상태: 파일, 실행(run), 실행 안의 문서, 이벤트 로그. better-sqlite3(packages/db가 쓰는 드라이버)의
 * 동기 트랜잭션으로 "상태 전이 + 이벤트 기록"을 한 번에 저장한다. 모든 조회는 tenant 범위다.
 * Verdict 평가 자체는 @verdict-ai/db의 Store에 따로 저장된다.
 */
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import type { CompiledRequirements } from "./compile.js";
import type { Extraction } from "./extract.js";
import type { DocResult } from "./review.js";

export type FileStatus = "preparing" | "ready" | "error";
export type RunStatus = "preparing" | "running" | "pausing" | "paused" | "completed" | "failed";
export type DocStatus = "queued" | "reviewing" | "met" | "not_met" | "needs_review" | "error";
export type Stage = "reading" | "checking" | "saving";
export const DONE: DocStatus[] = ["met", "not_met", "needs_review"];

export interface FileRow { id: string; tenantId: string; name: string; mime: string; bytes: number; sha256: string; path: string; status: FileStatus; error: string | null; extraction: Extraction | null; createdAt: string; deletedAt: string | null }
export interface RunRow { id: string; tenantId: string; status: RunStatus; requirement: string; compiled: CompiledRequirements | null; settings: Record<string, unknown>; error: string | null; lastSeq: number; createdAt: string; updatedAt: string }
export interface DocRow { runId: string; docId: string; position: number; fileId: string; fileName: string; fileSha256: string; status: DocStatus; stage: Stage | null; attempt: number; evaluationId: string | null; result: DocResult | null; error: string | null; startedAt: string | null; completedAt: string | null }
export interface EventRow { runId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }

const MIGRATIONS = [
  `CREATE TABLE files (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
     path TEXT NOT NULL, status TEXT NOT NULL, error TEXT, extraction_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
   CREATE INDEX files_tenant ON files(tenant_id, status);
   CREATE TABLE runs (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, requirement_text TEXT NOT NULL, compiled_json TEXT, settings_json TEXT NOT NULL,
     error TEXT, last_seq INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE UNIQUE INDEX runs_idem ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
   CREATE INDEX runs_status ON runs(status, created_at);
   CREATE TABLE run_docs (
     run_id TEXT NOT NULL REFERENCES runs(id), doc_id TEXT NOT NULL, position INTEGER NOT NULL, file_id TEXT NOT NULL, file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL,
     status TEXT NOT NULL, stage TEXT, attempt INTEGER NOT NULL DEFAULT 1, evaluation_id TEXT, result_json TEXT, error TEXT, started_at TEXT, completed_at TEXT,
     PRIMARY KEY (run_id, doc_id));
   CREATE INDEX run_docs_order ON run_docs(run_id, status, position);
   CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, seq));`,
];

type Raw = Record<string, unknown>;
const json = <T>(v: unknown): T | null => (typeof v === "string" ? (JSON.parse(v) as T) : null);

function fileRow(r: Raw): FileRow {
  return { id: r.id as string, tenantId: r.tenant_id as string, name: r.name as string, mime: r.mime as string, bytes: r.bytes as number, sha256: r.sha256 as string, path: r.path as string, status: r.status as FileStatus, error: (r.error as string) ?? null, extraction: json<Extraction>(r.extraction_json), createdAt: r.created_at as string, deletedAt: (r.deleted_at as string) ?? null };
}
function runRow(r: Raw): RunRow {
  return { id: r.id as string, tenantId: r.tenant_id as string, status: r.status as RunStatus, requirement: r.requirement_text as string, compiled: json<CompiledRequirements>(r.compiled_json), settings: json<Record<string, unknown>>(r.settings_json) ?? {}, error: (r.error as string) ?? null, lastSeq: r.last_seq as number, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function docRow(r: Raw): DocRow {
  return { runId: r.run_id as string, docId: r.doc_id as string, position: r.position as number, fileId: r.file_id as string, fileName: r.file_name as string, fileSha256: r.file_sha256 as string, status: r.status as DocStatus, stage: (r.stage as Stage) ?? null, attempt: r.attempt as number, evaluationId: (r.evaluation_id as string) ?? null, result: json<DocResult>(r.result_json), error: (r.error as string) ?? null, startedAt: (r.started_at as string) ?? null, completedAt: (r.completed_at as string) ?? null };
}

export class Repo {
  readonly db: Database.Database;
  /** 이벤트가 기록된 뒤 `run:<id>`로 알린다(SSE 구독자). */
  readonly bus = new EventEmitter();
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.bus.setMaxListeners(0);
    const version = this.db.pragma("user_version", { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) this.db.transaction(() => { this.db.exec(MIGRATIONS[i]!); this.db.pragma(`user_version = ${i + 1}`); })();
  }
  private ts() { return new Date(this.now()).toISOString(); }
  private pending: EventRow[] = [];
  /** 트랜잭션이 커밋된 뒤에만 구독자에게 알린다(롤백된 이벤트는 버림). */
  private tx<T>(fn: () => T): T {
    try {
      const out = this.db.transaction(fn)();
      const events = this.pending.splice(0);
      for (const e of events) this.bus.emit(`run:${e.runId}`, e);
      return out;
    } catch (e) { this.pending = []; throw e; }
  }
  close() { this.db.close(); }

  /* ---------- files ---------- */
  insertFile(f: Omit<FileRow, "createdAt" | "deletedAt" | "extraction" | "error">) {
    const at = this.ts();
    this.db.prepare(`INSERT INTO files (id, tenant_id, name, mime, bytes, sha256, path, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(f.id, f.tenantId, f.name, f.mime, f.bytes, f.sha256, f.path, f.status, at, at);
  }
  getFile(id: string, tenantId: string): FileRow | undefined {
    const r = this.db.prepare(`SELECT * FROM files WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as Raw | undefined;
    return r ? fileRow(r) : undefined;
  }
  listFiles(ids: string[], tenantId: string): FileRow[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM files WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).all(tenantId, ...ids) as Raw[];
    const byId = new Map(rows.map((r) => [r.id as string, fileRow(r)]));
    return ids.map((id) => byId.get(id)).filter((f): f is FileRow => !!f);
  }
  filesToPrepare(): FileRow[] { return (this.db.prepare(`SELECT * FROM files WHERE status = 'preparing' AND deleted_at IS NULL ORDER BY created_at`).all() as Raw[]).map(fileRow); }
  setFileStatus(id: string, status: FileStatus, patch: { error?: string | null; extraction?: Extraction | null } = {}) {
    this.db.prepare(`UPDATE files SET status = ?, error = ?, extraction_json = COALESCE(?, extraction_json), updated_at = ? WHERE id = ?`).run(status, patch.error ?? null, patch.extraction ? JSON.stringify(patch.extraction) : null, this.ts(), id);
  }
  /** 실행이 참조하는 파일은 목록에서만 숨긴다(결과 보존). 지워도 되면 true. */
  removeFile(id: string, tenantId: string): "deleted" | "hidden" | "missing" {
    return this.tx(() => {
      if (!this.getFile(id, tenantId)) return "missing";
      const used = this.db.prepare(`SELECT 1 FROM run_docs WHERE file_id = ? LIMIT 1`).get(id);
      if (used) { this.db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ?`).run(this.ts(), id); return "hidden"; }
      this.db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
      return "deleted";
    });
  }

  /* ---------- runs ---------- */
  findRunByKey(tenantId: string, key: string): RunRow | undefined {
    const r = this.db.prepare(`SELECT * FROM runs WHERE tenant_id = ? AND idempotency_key = ?`).get(tenantId, key) as Raw | undefined;
    return r ? runRow(r) : undefined;
  }
  createRun(run: { id: string; tenantId: string; requirement: string; settings: Record<string, unknown>; idempotencyKey?: string }, files: FileRow[]): RunRow {
    const at = this.ts();
    this.tx(() => {
      this.db.prepare(`INSERT INTO runs (id, tenant_id, status, requirement_text, settings_json, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(run.id, run.tenantId, "preparing", run.requirement, JSON.stringify(run.settings), run.idempotencyKey ?? null, at, at);
      const ins = this.db.prepare(`INSERT INTO run_docs (run_id, doc_id, position, file_id, file_name, file_sha256, status) VALUES (?,?,?,?,?,?, 'queued')`);
      files.forEach((f, i) => ins.run(run.id, `d${String(i + 1).padStart(4, "0")}`, i, f.id, f.name, f.sha256));
      this.appendEventTx(run.id, "run.status", { status: "preparing" });
    });
    return this.getRun(run.id, run.tenantId)!;
  }
  getRun(id: string, tenantId?: string): RunRow | undefined {
    const r = (tenantId === undefined ? this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) : this.db.prepare(`SELECT * FROM runs WHERE id = ? AND tenant_id = ?`).get(id, tenantId)) as Raw | undefined;
    return r ? runRow(r) : undefined;
  }
  /** 실행기가 처리할 실행(생성 순). */
  activeRuns(): RunRow[] { return (this.db.prepare(`SELECT * FROM runs WHERE status IN ('preparing','running','pausing') ORDER BY created_at, id`).all() as Raw[]).map(runRow); }

  /** 조건부 상태 전이. 현재 상태가 from에 있을 때만 바꾸고 이벤트를 남긴다. */
  transitionRun(id: string, from: RunStatus[], to: RunStatus, patch: { error?: string | null; compiled?: CompiledRequirements } = {}, event?: Record<string, unknown>): boolean {
    return this.tx(() => {
      const res = this.db.prepare(`UPDATE runs SET status = ?, error = ?, compiled_json = COALESCE(?, compiled_json), updated_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`)
        .run(to, patch.error ?? null, patch.compiled ? JSON.stringify(patch.compiled) : null, this.ts(), id, ...from);
      if (!res.changes) return false;
      this.appendEventTx(id, "run.status", { status: to, ...(patch.error ? { error: patch.error } : {}), ...event });
      return true;
    });
  }

  /* ---------- docs ---------- */
  listDocs(runId: string): DocRow[] { return (this.db.prepare(`SELECT * FROM run_docs WHERE run_id = ? ORDER BY position`).all(runId) as Raw[]).map(docRow); }
  getDoc(runId: string, docId: string): DocRow | undefined {
    const r = this.db.prepare(`SELECT * FROM run_docs WHERE run_id = ? AND doc_id = ?`).get(runId, docId) as Raw | undefined;
    return r ? docRow(r) : undefined;
  }
  nextQueued(runId: string): DocRow | undefined {
    const r = this.db.prepare(`SELECT * FROM run_docs WHERE run_id = ? AND status = 'queued' ORDER BY position LIMIT 1`).get(runId) as Raw | undefined;
    return r ? docRow(r) : undefined;
  }
  counts(runId: string): Record<DocStatus, number> {
    const out: Record<DocStatus, number> = { queued: 0, reviewing: 0, met: 0, not_met: 0, needs_review: 0, error: 0 };
    for (const r of this.db.prepare(`SELECT status, COUNT(*) AS n FROM run_docs WHERE run_id = ? GROUP BY status`).all(runId) as Array<{ status: DocStatus; n: number }>) out[r.status] = r.n;
    return out;
  }
  /** 문서 상태 조건부 전이 + 이벤트를 한 트랜잭션으로. 이미 다른 상태면 아무것도 하지 않고 false. */
  transitionDoc(runId: string, docId: string, from: DocStatus[], to: DocStatus, patch: Partial<Pick<DocRow, "stage" | "evaluationId" | "result" | "error" | "startedAt" | "completedAt">> & { attemptPlus?: boolean }, event?: { type: string; payload: Record<string, unknown> }): boolean {
    return this.tx(() => {
      const sets = ["status = ?"];
      const vals: unknown[] = [to];
      const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
      if ("stage" in patch) put("stage", patch.stage);
      if ("evaluationId" in patch) put("evaluation_id", patch.evaluationId);
      if ("result" in patch) put("result_json", patch.result ? JSON.stringify(patch.result) : null);
      if ("error" in patch) put("error", patch.error);
      if ("startedAt" in patch) put("started_at", patch.startedAt);
      if ("completedAt" in patch) put("completed_at", patch.completedAt);
      if (patch.attemptPlus) sets.push("attempt = attempt + 1");
      const res = this.db.prepare(`UPDATE run_docs SET ${sets.join(", ")} WHERE run_id = ? AND doc_id = ? AND status IN (${from.map(() => "?").join(",")})`).run(...vals, runId, docId, ...from);
      if (!res.changes) return false;
      if (event) this.appendEventTx(runId, event.type, { docId, ...event.payload });
      return true;
    });
  }
  /** 같은 상태 안에서 단계만 바꾼다(reviewing 문서). */
  setStage(runId: string, docId: string, stage: Stage): boolean {
    return this.tx(() => {
      const res = this.db.prepare(`UPDATE run_docs SET stage = ? WHERE run_id = ? AND doc_id = ? AND status = 'reviewing'`).run(stage, runId, docId);
      if (res.changes) this.appendEventTx(runId, "doc.stage", { docId, stage });
      return res.changes > 0;
    });
  }

  /* ---------- events ---------- */
  appendEvent(runId: string, type: string, payload: Record<string, unknown>): number { return this.tx(() => this.appendEventTx(runId, type, payload)); }
  private appendEventTx(runId: string, type: string, payload: Record<string, unknown>): number {
    this.db.prepare(`UPDATE runs SET last_seq = last_seq + 1 WHERE id = ?`).run(runId);
    const seq = (this.db.prepare(`SELECT last_seq FROM runs WHERE id = ?`).get(runId) as { last_seq: number }).last_seq;
    const createdAt = this.ts();
    this.db.prepare(`INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?,?,?,?,?)`).run(runId, seq, type, JSON.stringify(payload), createdAt);
    // 커밋 뒤에 알린다: 구독자가 아직 저장되지 않은 이벤트를 보지 않도록.
    this.pending.push({ runId, seq, type, payload, createdAt });
    return seq;
  }
  listEvents(runId: string, after: number, limit = 1000): EventRow[] {
    return (this.db.prepare(`SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(runId, after, limit) as Raw[]).map((r) => ({ runId: r.run_id as string, seq: r.seq as number, type: r.type as string, payload: JSON.parse(r.payload_json as string) as Record<string, unknown>, createdAt: r.created_at as string }));
  }
}
