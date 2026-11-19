/**
 * 서버 백그라운드 실행기. 실행(run)을 생성 순으로, 실행 안의 문서를 position 순으로 한 건씩 처리한다.
 * 브라우저와 무관하게 돌고, 모든 상태 전이는 DB에 기록된 뒤에만 이벤트로 나간다.
 * 일시정지는 현재 문서를 저장한 뒤 다음 문서를 시작하지 않는 방식이다.
 */
import type { Engine, EngineEvent } from "@verdict-ai/core";
import { compileRequirements } from "./compile.js";
import type { Repo, RunRow, DocRow } from "./db.js";
import type { LlmClient } from "./llm.js";
import { reviewDocument, ReviewError, type ReviewSettings } from "./review.js";

export interface RunnerDeps {
  repo: Repo;
  engine: Engine;
  llm: LlmClient;
  settings: ReviewSettings;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/** Engine의 criterion.scored 이벤트를 문서 이벤트로 옮기기 위한 라우터(Engine.onEvent에 연결). */
export class EngineEventRouter {
  private routes = new Map<string, (e: EngineEvent) => void>();
  readonly handler = (e: EngineEvent) => {
    const id = "evaluationId" in e ? e.evaluationId : e.evaluation.id;
    this.routes.get(id)?.(e);
  };
  on(evaluationId: string, fn: (e: EngineEvent) => void) { this.routes.set(evaluationId, fn); return () => this.routes.delete(evaluationId); }
}

export class Runner {
  private wake?: () => void;
  private loopDone?: Promise<void>;
  private stopped = false;
  private busy = false;
  readonly router: EngineEventRouter;
  constructor(private deps: RunnerDeps, router?: EngineEventRouter) { this.router = router ?? new EngineEventRouter(); }
  private now() { return new Date((this.deps.now ?? Date.now)()).toISOString(); }

  /** 재시작 복구: 결과가 저장되지 않은 reviewing 문서를 대기로 되돌린다. 완료 문서는 그대로. */
  recover() {
    const { repo } = this.deps;
    for (const run of repo.activeRuns()) {
      for (const d of repo.listDocs(run.id)) {
        if (d.status === "reviewing") repo.transitionDoc(run.id, d.docId, ["reviewing"], "queued", { stage: null, startedAt: null }, { type: "doc.requeued", payload: { reason: "restart" } });
      }
    }
  }

  start() {
    this.recover();
    this.stopped = false;
    this.loopDone = this.loop();
  }
  async stop() { this.stopped = true; this.kick(); await this.loopDone; }
  kick() { this.wake?.(); }

  private async loop() {
    while (!this.stopped) {
      const worked = await this.step();
      if (!worked && !this.stopped) await new Promise<void>((r) => { this.wake = r; setTimeout(r, 5000).unref?.(); });
    }
  }

  /** 한 단위 작업(컴파일 1회 또는 문서 1건 또는 상태 정리). 할 일이 없으면 false. 테스트에서 직접 호출. */
  async step(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const run = this.deps.repo.activeRuns()[0];
      if (!run) return false;
      if (run.status === "preparing") await this.compile(run);
      else await this.advance(run);
      return true;
    } catch (e) {
      this.deps.log?.("runner step failed", e);
      return false;
    } finally { this.busy = false; }
  }

  /** 테스트·스크립트용: 할 일이 없어질 때까지. */
  async drain(max = 10_000) { for (let i = 0; i < max && (await this.step()); i++); }

  /** 실행 시작 때 고정한 설정(없으면 서버 기본값). */
  private settingsOf(run: RunRow): ReviewSettings { return (run.settings.review as ReviewSettings | undefined) ?? this.deps.settings; }

  private async compile(run: RunRow) {
    const { repo, llm } = this.deps;
    const settings = this.settingsOf(run);
    try {
      const compiled = await compileRequirements(run.requirement, llm, settings.llmModel);
      repo.transitionRun(run.id, ["preparing"], "running", { compiled }, { requirements: compiled.requirements.map((r) => ({ id: r.id, text: r.text })) });
    } catch (e) {
      repo.transitionRun(run.id, ["preparing"], "failed", { error: `요건 해석 실패: ${(e as Error).message}` });
    }
  }

  private async advance(run: RunRow) {
    const { repo } = this.deps;
    if (run.status === "pausing") { repo.transitionRun(run.id, ["pausing"], "paused"); return; }
    const doc = repo.nextQueued(run.id);
    if (!doc) { repo.transitionRun(run.id, ["running"], "completed"); return; }
    await this.reviewOne(run, doc);
  }

  private async reviewOne(run: RunRow, doc: DocRow) {
    const { repo, engine, llm } = this.deps;
    const settings = this.settingsOf(run);
    const evaluationId = `ev_${run.id}_${doc.docId}_${doc.attempt}`;
    if (!repo.transitionDoc(run.id, doc.docId, ["queued"], "reviewing", { stage: "reading", startedAt: this.now(), evaluationId, error: null }, { type: "doc.started", payload: { position: doc.position, attempt: doc.attempt } })) return;
    try {
      const file = repo.getFile(doc.fileId, run.tenantId);
      if (!file?.extraction || file.status !== "ready") throw new ReviewError("파일 추출본이 없습니다");
      const result = await reviewDocument(
        { compiled: run.compiled!, extraction: file.extraction, evaluationId, docName: doc.fileName, runId: run.id, docId: doc.docId },
        {
          engine, llm, settings, tenantId: run.tenantId,
          onStage: (stage) => { repo.setStage(run.id, doc.docId, stage); },
          onRequirement: (requirementId, outcome) => { repo.appendEvent(run.id, "doc.requirement", { docId: doc.docId, requirementId, outcome }); },
          listen: (id, fn) => this.router.on(id, fn),
        },
      );
      repo.setStage(run.id, doc.docId, "saving");
      repo.transitionDoc(run.id, doc.docId, ["reviewing"], result.verdict, { stage: null, result, completedAt: this.now() }, { type: "doc.completed", payload: { verdict: result.verdict } });
    } catch (e) {
      const message = e instanceof ReviewError ? e.message : `처리 오류: ${(e as Error).message}`;
      try { repo.transitionDoc(run.id, doc.docId, ["reviewing"], "error", { stage: null, error: message, completedAt: this.now() }, { type: "doc.failed", payload: { error: message } }); }
      catch (saveError) { this.deps.log?.("결과 저장 실패", saveError); }
    }
  }

  /* ---------- 제어 ---------- */
  pause(run: RunRow) { const ok = this.deps.repo.transitionRun(run.id, ["running"], "pausing"); this.kick(); return ok; }
  resume(run: RunRow) { const ok = this.deps.repo.transitionRun(run.id, ["paused", "pausing"], "running"); this.kick(); return ok; }
  retryDoc(run: RunRow, docId: string): boolean {
    const { repo } = this.deps;
    const ok = repo.transitionDoc(run.id, docId, ["error"], "queued", { stage: null, error: null, result: null, startedAt: null, completedAt: null, attemptPlus: true }, { type: "doc.requeued", payload: { reason: "retry" } });
    if (ok) repo.transitionRun(run.id, ["completed"], "running");
    this.kick();
    return ok;
  }
  retryCompile(run: RunRow) { const ok = this.deps.repo.transitionRun(run.id, ["failed"], "preparing"); this.kick(); return ok; }
}
