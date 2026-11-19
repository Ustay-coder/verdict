/**
 * 파일 저장과 준비(형식 검증 + 텍스트/OCR 추출). 업로드 직후 백그라운드에서 병렬(기본 2개)로 준비한다.
 * 저장 경로는 서버가 만든 id로만 정해진다(사용자 파일명은 경로에 쓰지 않음).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo, FileRow } from "./db.js";
import { extractDocument, ExtractionError, MAX_FILE_BYTES, type ExtractDeps } from "./extract.js";

export class FileStorage {
  constructor(private dir: string) {}
  private pathFor(tenantId: string, id: string) {
    const tenant = createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
    return join(this.dir, "files", tenant, id);
  }
  async save(tenantId: string, id: string, bytes: Uint8Array): Promise<string> {
    const path = this.pathFor(tenantId, id);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    return path;
  }
  read(path: string) { return readFile(path).then((b) => new Uint8Array(b)); }
  remove(path: string) { return rm(path, { force: true }); }
}

export class FilePreparer {
  private queue: string[] = [];
  private active = 0;
  private idle: Array<() => void> = [];
  constructor(private repo: Repo, private storage: FileStorage, private deps: ExtractDeps, private concurrency = 2, private log?: (m: string, e?: unknown) => void) {}

  async accept(tenantId: string, name: string, mime: string, bytes: Uint8Array): Promise<FileRow> {
    const id = `file_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = await this.storage.save(tenantId, id, bytes);
    const tooBig = bytes.length > MAX_FILE_BYTES;
    this.repo.insertFile({ id, tenantId, name, mime, bytes: bytes.length, sha256, path, status: tooBig ? "error" : "preparing" });
    if (tooBig) this.repo.setFileStatus(id, "error", { error: "파일이 25MB를 넘습니다" });
    else this.enqueue(id);
    return this.repo.getFile(id, tenantId)!;
  }

  /** 준비 실패 파일을 다시 준비한다. */
  retry(file: FileRow): boolean {
    if (file.status !== "error" || file.bytes > MAX_FILE_BYTES) return false;
    this.repo.setFileStatus(file.id, "preparing");
    this.enqueue(file.id);
    return true;
  }

  discard(path: string) { return this.storage.remove(path); }

  /** 서버 재시작 시 준비 중이던 파일을 다시 넣는다. */
  resume() { for (const f of this.repo.filesToPrepare()) this.enqueue(f.id); }

  enqueue(id: string) { if (!this.queue.includes(id)) this.queue.push(id); this.pump(); }

  /** 준비 중이거나 대기 중인 파일이 있으면 true. */
  busy() { return this.active > 0 || this.queue.length > 0; }

  /** 테스트용: 대기 중인 준비가 끝날 때까지. */
  whenIdle(): Promise<void> { return this.active || this.queue.length ? new Promise((r) => this.idle.push(r)) : Promise.resolve(); }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      void this.prepare(id).finally(() => {
        this.active--;
        this.pump();
        if (!this.active && !this.queue.length) this.idle.splice(0).forEach((r) => r());
      });
    }
  }

  private async prepare(id: string) {
    const row = this.repo.db.prepare(`SELECT path, status FROM files WHERE id = ?`).get(id) as { path: string; status: string } | undefined;
    if (!row || row.status !== "preparing") return;
    try {
      const extraction = await extractDocument(await this.storage.read(row.path), this.deps);
      this.repo.setFileStatus(id, "ready", { extraction });
    } catch (e) {
      const message = e instanceof ExtractionError ? e.message : `준비 실패: ${(e as Error).message}`;
      if (!(e instanceof ExtractionError)) this.log?.(`prepare ${id} failed`, e);
      this.repo.setFileStatus(id, "error", { error: message.slice(0, 200) });
    }
  }
}
