/**
 * HTTP 계약(docs/verdict-review/spec.md §8). 인증은 Verdict API와 같은 체계(API 키 → tenant, @verdict-ai/api의 Auth)를
 * 쓰고, 브라우저는 httpOnly 쿠키로 같은 키를 보낸다. 모든 조회는 tenant 범위다.
 */
import type { Auth } from "@verdict-ai/api";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { COMPILER_VERSION } from "./compile.js";
import type { DocRow, EventRow, FileRow, Repo, RunRow } from "./db.js";
import type { FilePreparer } from "./files.js";
import type { ReviewSettings } from "./review.js";
import type { Runner } from "./runner.js";

export interface AppDeps { repo: Repo; runner: Runner; preparer: FilePreparer; auth: Auth; settings: ReviewSettings; heartbeatMs?: number; maxFilesPerRun?: number }
type Env = { Variables: { tenantId: string } };

export const MAX_REQUIREMENT_CHARS = 4000;
const COOKIE = "verdict_key";

export function fileView(f: FileRow) { return { id: f.id, name: f.name, status: f.status, ...(f.error ? { error: f.error } : {}) }; }
export function docView(d: DocRow) {
  return { docId: d.docId, position: d.position, fileName: d.fileName, status: d.status, stage: d.stage, attempt: d.attempt, startedAt: d.startedAt, completedAt: d.completedAt, ...(d.error ? { error: d.error } : {}) };
}
export function snapshot(repo: Repo, run: RunRow) {
  const docs = repo.listDocs(run.id);
  // 같은 동기 구간에서 읽으므로 lastSeq와 문서 상태가 일치한다.
  const fresh = repo.getRun(run.id)!;
  return {
    run: { id: fresh.id, status: fresh.status, error: fresh.error, lastSeq: fresh.lastSeq, requirement: fresh.requirement, createdAt: fresh.createdAt, requirements: fresh.compiled?.requirements.map((r) => ({ id: r.id, text: r.text })) ?? [] },
    docs: docs.map(docView),
    counts: repo.counts(run.id),
  };
}

export function createReviewApp(deps: AppDeps) {
  const { repo, runner, preparer, auth } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: { message: err.message } }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: { message: "요청 형식이 올바르지 않습니다", issues: err.issues } }, 400);
    console.error(err);
    return c.json({ error: { message: "서버 오류" } }, 500);
  });

  // busy: 진행 중인 실행이나 준비 중인 파일이 있음. 배포 환경의 앞단이 이 값을 보고 컨테이너를 꺼지지 않게 둔다(내용은 담지 않는다).
  app.get("/api/health", (c) => c.json({ ok: true, busy: repo.activeRuns().length > 0 || preparer.busy() }));

  app.post("/api/session", async (c) => {
    const { apiKey } = z.object({ apiKey: z.string().min(1) }).parse(await c.req.json());
    const who = await auth.resolve(apiKey, c.req.raw);
    if (who === undefined) throw new HTTPException(401, { message: "API 키가 올바르지 않습니다" });
    setCookie(c, COOKIE, apiKey, { httpOnly: true, sameSite: "Strict", path: "/api", secure: new URL(c.req.url).protocol === "https:" });
    return c.body(null, 204);
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/session") return next();
    const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? getCookie(c, COOKIE);
    const who = await auth.resolve(key, c.req.raw);
    if (who === undefined) throw new HTTPException(401, { message: "인증이 필요합니다" });
    c.set("tenantId", typeof who === "string" ? who : who.tenantId);
    await next();
  });

  /* ---------- files ---------- */
  app.post("/api/files", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new HTTPException(400, { message: "file 필드가 없습니다" });
    const row = await preparer.accept(c.var.tenantId, file.name.normalize("NFC").slice(0, 255) || "이름 없음", file.type || "application/octet-stream", new Uint8Array(await file.arrayBuffer()));
    return c.json(fileView(row), 201);
  });
  app.get("/api/files", (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    return c.json({ data: repo.listFiles(ids, c.var.tenantId).map(fileView) });
  });
  app.post("/api/files/:id/prepare", (c) => {
    const f = repo.getFile(c.req.param("id"), c.var.tenantId);
    if (!f || f.deletedAt) throw new HTTPException(404, { message: "파일이 없습니다" });
    if (!preparer.retry(f)) throw new HTTPException(409, { message: "다시 준비할 수 없는 상태입니다" });
    return c.json(fileView(repo.getFile(f.id, c.var.tenantId)!), 202);
  });
  app.delete("/api/files/:id", async (c) => {
    const f = repo.getFile(c.req.param("id"), c.var.tenantId);
    const outcome = repo.removeFile(c.req.param("id"), c.var.tenantId);
    if (outcome === "missing") throw new HTTPException(404, { message: "파일이 없습니다" });
    if (outcome === "deleted" && f) await preparer.discard(f.path);
    return c.body(null, 204);
  });

  /* ---------- runs ---------- */
  const maxFiles = deps.maxFilesPerRun ?? 500;
  const RunBody = z.object({ requirement: z.string().max(MAX_REQUIREMENT_CHARS), fileIds: z.array(z.string()).min(1) });
  app.post("/api/runs", async (c) => {
    const body = RunBody.parse(await c.req.json());
    const requirement = body.requirement.trim();
    if (!requirement) throw new HTTPException(400, { message: "요건이 비어 있습니다" });
    if (body.fileIds.length > maxFiles) throw new HTTPException(400, { message: `한 번에 ${maxFiles}건까지 검토할 수 있습니다` });
    if (new Set(body.fileIds).size !== body.fileIds.length) throw new HTTPException(400, { message: "같은 파일이 두 번 들어 있습니다" });
    const tenantId = c.var.tenantId;
    const key = c.req.header("idempotency-key")?.slice(0, 200);
    if (key) {
      const existing = repo.findRunByKey(tenantId, key);
      if (existing) return c.json(snapshot(repo, existing), 200);
    }
    const files = repo.listFiles(body.fileIds, tenantId);
    if (files.length !== body.fileIds.length) throw new HTTPException(404, { message: "찾을 수 없는 파일이 있습니다" });
    const notReady = files.filter((f) => f.status !== "ready");
    if (notReady.length) throw new HTTPException(409, { message: `준비되지 않은 파일이 있습니다: ${notReady.map((f) => f.name).join(", ")}` });
    const run = repo.createRun({ id: `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`, tenantId, requirement, settings: { review: deps.settings, compiler: COMPILER_VERSION }, idempotencyKey: key }, files);
    runner.kick();
    return c.json(snapshot(repo, run), 201);
  });

  const loadRun = (c: Context<Env>) => {
    const run = repo.getRun(c.req.param("id")!, c.var.tenantId);
    if (!run) throw new HTTPException(404, { message: "검토를 찾을 수 없습니다" });
    return run;
  };
  app.get("/api/runs/:id", (c) => c.json(snapshot(repo, loadRun(c))));
  app.get("/api/runs/:id/docs/:docId", (c) => {
    const run = loadRun(c);
    const doc = repo.getDoc(run.id, c.req.param("docId"));
    if (!doc) throw new HTTPException(404, { message: "문서를 찾을 수 없습니다" });
    return c.json({ ...docView(doc), evaluationId: doc.evaluationId, result: doc.result });
  });
  const control = (name: "pause" | "resume" | "retryCompile") => async (c: Context<Env>) => {
    const run = loadRun(c);
    if (!runner[name](run)) throw new HTTPException(409, { message: "지금 상태에서는 할 수 없습니다" });
    return c.json(snapshot(repo, run));
  };
  app.post("/api/runs/:id/pause", control("pause"));
  app.post("/api/runs/:id/resume", control("resume"));
  app.post("/api/runs/:id/retry", control("retryCompile"));
  app.post("/api/runs/:id/docs/:docId/retry", (c) => {
    const run = loadRun(c);
    if (!runner.retryDoc(run, c.req.param("docId"))) throw new HTTPException(409, { message: "오류 상태의 문서만 다시 검토할 수 있습니다" });
    return c.json(snapshot(repo, run));
  });

  app.get("/api/runs/:id/events", (c) => {
    const run = loadRun(c);
    const header = c.req.header("last-event-id");
    const after = Number(header ?? c.req.query("after") ?? 0) || 0;
    // 프록시(Cloudflare 등)가 이벤트를 모아 두지 않게 한다.
    c.header("x-accel-buffering", "no");
    c.header("cache-control", "no-cache, no-transform");
    return streamSSE(c, async (stream) => {
      let last = after;
      const queue: EventRow[] = [];
      let notify: (() => void) | undefined;
      const listener = (e: EventRow) => { queue.push(e); notify?.(); };
      // 구독을 먼저 걸고 저장된 이벤트를 보낸다. seq로 중복을 거른다.
      repo.bus.on(`run:${run.id}`, listener);
      let closed = false;
      stream.onAbort(() => { closed = true; notify?.(); });
      const send = async (e: EventRow) => {
        if (e.seq <= last) return;
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify({ seq: e.seq, ...e.payload }) });
      };
      try {
        for (let batch = repo.listEvents(run.id, last); batch.length; batch = repo.listEvents(run.id, last)) for (const e of batch) await send(e);
        while (!closed) {
          while (queue.length) await send(queue.shift()!);
          await new Promise<void>((r) => { notify = r; setTimeout(r, deps.heartbeatMs ?? 15_000); });
          notify = undefined;
          if (!queue.length && !closed) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally { repo.bus.off(`run:${run.id}`, listener); }
    });
  });

  return app;
}
