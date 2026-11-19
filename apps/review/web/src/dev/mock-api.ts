/**
 * 개발용 모형 API(UI 시안 전용). 타이머로 진행을 흉내 내며, 판정은 fixtures.ts의 미리 정한 가짜 값이다.
 * 운영 화면(main.tsx)은 이 파일을 import하지 않는다. 실제 서버와 같은 이벤트 계약(spec.md §10)을 따른다.
 */
import type { ReviewApi } from "@/lib/api";
import type { DocDetail, DocStatus, DocView, FileView, Outcome, RunEvent, RunSnapshot, RunStatus, RunView } from "@/lib/types";
import { SAMPLE_FACT, SAMPLE_REQUIREMENTS, sampleOutcomes } from "./fixtures";

interface MockRun { run: RunView; docs: DocView[]; events: RunEvent[]; outcomes: Map<string, Record<string, Outcome>>; listeners: Set<(e: RunEvent) => void>; timer?: ReturnType<typeof setTimeout> }

export interface MockOptions { speed?: number; uploadSpeed?: number; frozenPreparing?: boolean }

export function createMockApi(opts: MockOptions = {}) {
  const speed = () => opts.speed ?? 1;
  const files = new Map<string, FileView>();
  const runs = new Map<string, MockRun>();
  let seq = 0;
  const id = (p: string) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms / speed());

  const snapshot = (r: MockRun): RunSnapshot => {
    const counts = { queued: 0, reviewing: 0, met: 0, not_met: 0, needs_review: 0, error: 0 } as Record<DocStatus, number>;
    r.docs.forEach((d) => counts[d.status]++);
    return structuredClone({ run: r.run, docs: r.docs, counts });
  };
  const emit = (r: MockRun, type: string, payload: Record<string, unknown>) => {
    const e: RunEvent = { seq: r.run.lastSeq + 1, type, ...payload };
    r.run.lastSeq = e.seq;
    r.events.push(e);
    r.listeners.forEach((l) => l(e));
  };
  const setStatus = (r: MockRun, status: RunStatus, extra: Record<string, unknown> = {}) => { r.run.status = status; emit(r, "run.status", { status, ...extra }); };

  function advance(r: MockRun) {
    if (r.run.status === "pausing") { setStatus(r, "paused"); return; }
    if (r.run.status !== "running") return;
    const doc = r.docs.find((d) => d.status === "queued");
    if (!doc) { setStatus(r, "completed"); return; }
    const outcomes = r.outcomes.get(doc.docId)!;
    doc.status = "reviewing"; doc.stage = "reading";
    emit(r, "doc.started", { docId: doc.docId, position: doc.position, attempt: doc.attempt });
    r.timer = later(500, () => {
      doc.stage = "checking"; emit(r, "doc.stage", { docId: doc.docId, stage: "checking" });
      SAMPLE_REQUIREMENTS.forEach((req, i) => { r.timer = later(250 * (i + 1), () => emit(r, "doc.requirement", { docId: doc.docId, requirementId: req.id, outcome: outcomes[req.id] })); });
      r.timer = later(1000, () => {
        doc.stage = "saving"; emit(r, "doc.stage", { docId: doc.docId, stage: "saving" });
        r.timer = later(300, () => {
          if (doc.fileName.includes("오류")) { doc.status = "error"; doc.stage = null; doc.error = "모형 처리 오류 (예시)"; emit(r, "doc.failed", { docId: doc.docId, error: doc.error }); }
          else {
            const vals = Object.values(outcomes);
            const verdict: Outcome = vals.includes("not_met") ? "not_met" : vals.includes("needs_review") ? "needs_review" : "met";
            doc.status = verdict; doc.stage = null; doc.completedAt = new Date().toISOString();
            emit(r, "doc.completed", { docId: doc.docId, verdict });
          }
          r.timer = later(250, () => advance(r));
        });
      });
    });
  }

  const api: ReviewApi = {
    uploadFile(file, onProgress) {
      return new Promise((resolve) => {
        let p = 0;
        const t = setInterval(() => {
          p = Math.min(1, p + 0.08 * (opts.uploadSpeed ?? 1));
          onProgress(p);
          if (p >= 1) {
            clearInterval(t);
            const view: FileView = { id: id("file"), name: file.name, status: "preparing" };
            files.set(view.id, view);
            if (!opts.frozenPreparing) later(900, () => { Object.assign(view, file.name.includes("손상") ? { status: "error", error: "PDF를 열 수 없습니다 (예시)" } : { status: "ready" }); });
            resolve({ ...view });
          }
        }, 80);
      });
    },
    async getFiles(ids) { return ids.map((i) => files.get(i)).filter((f): f is FileView => !!f).map((f) => ({ ...f })); },
    async prepareFile(fid) { const f = files.get(fid)!; f.status = "preparing"; delete f.error; later(900, () => { f.status = "ready"; }); return { ...f }; },
    async deleteFile(fid) { files.delete(fid); },
    async startRun(requirement, fileIds) {
      const runId = id("run");
      const docs: DocView[] = fileIds.map((fid, i) => ({ docId: `d${String(i + 1).padStart(4, "0")}`, position: i, fileName: files.get(fid)?.name ?? fid, status: "queued", stage: null, attempt: 1 }));
      const r: MockRun = { run: { id: runId, status: "preparing", error: null, lastSeq: 0, requirement, requirements: [] }, docs, events: [], outcomes: new Map(docs.map((d, i) => [d.docId, sampleOutcomes(i)])), listeners: new Set() };
      runs.set(runId, r);
      emit(r, "run.status", { status: "preparing" });
      later(900, () => { r.run.requirements = SAMPLE_REQUIREMENTS; setStatus(r, "running", { requirements: SAMPLE_REQUIREMENTS }); later(300, () => advance(r)); });
      return snapshot(r);
    },
    async getRun(rid) { return snapshot(runs.get(rid)!); },
    async getDoc(rid, docId): Promise<DocDetail> {
      const r = runs.get(rid)!;
      const d = r.docs.find((x) => x.docId === docId)!;
      const outcomes = r.outcomes.get(docId)!;
      const done = d.status === "met" || d.status === "not_met" || d.status === "needs_review";
      return {
        ...d, evaluationId: done ? `ev_example_${docId}` : null,
        result: done ? {
          verdict: d.status as Outcome, evaluationId: `ev_example_${docId}`, warnings: [], models: { facts: "예시", judge: "예시" },
          requirements: SAMPLE_REQUIREMENTS.map((req) => {
            const o = outcomes[req.id]!;
            const fact = SAMPLE_FACT[req.id]!;
            return {
              id: req.id, text: req.text, outcome: o, judge: req.id === "r2" ? "decision" as const : "formula" as const,
              reason: o === "needs_review" ? `문서에서 ${req.text.replace(/ 이상$/, "")} 값을 찾지 못함 (예시)` : `예시 사유 — ${o === "met" ? "기준을 만족" : "기준에 미달"}`,
              facts: o === "needs_review" ? [] : [{ ...fact, source: "text" as const }],
              rejected: [], needed: o === "needs_review" ? ["2025년 손익계산서 등 매출액이 적힌 자료 (예시)"] : [],
            };
          }),
        } : null,
      };
    },
    subscribe(rid, after, onEvent) {
      const r = runs.get(rid)!;
      queueMicrotask(() => r.events.filter((e) => e.seq > after).forEach(onEvent));
      r.listeners.add(onEvent);
      return { close: () => r.listeners.delete(onEvent) };
    },
    async pause(rid) { const r = runs.get(rid)!; if (r.run.status === "running") setStatus(r, "pausing"); return snapshot(r); },
    async resume(rid) { const r = runs.get(rid)!; if (r.run.status === "paused" || r.run.status === "pausing") { const wasPaused = r.run.status === "paused"; setStatus(r, "running"); if (wasPaused) later(200, () => advance(r)); } return snapshot(r); },
    async retryDoc(rid, docId) {
      const r = runs.get(rid)!; const d = r.docs.find((x) => x.docId === docId)!;
      d.status = "queued"; d.attempt++; d.fileName = d.fileName.replace("오류", "재시도"); delete d.error; emit(r, "doc.requeued", { docId, reason: "retry" });
      if (r.run.status === "completed") { setStatus(r, "running"); later(200, () => advance(r)); }
      return snapshot(r);
    },
    async retryRun(rid) { return snapshot(runs.get(rid)!); },
  };

  /** 시안용: 준비된 파일을 미리 넣는다. */
  const seedFiles = (names: string[], status: FileView["status"] = "ready", error?: string) => names.map((name) => { const f: FileView = { id: id("file"), name, status, ...(error ? { error } : {}) }; files.set(f.id, f); return { id: f.id, name }; });
  /** 시안용: 모든 문서가 끝난 실행을 만든다(모션 없이 결과만). */
  const seedCompletedRun = (names: string[]) => {
    const runId = id("run");
    const r: MockRun = { run: { id: runId, status: "completed", error: null, lastSeq: 0, requirement: "", requirements: SAMPLE_REQUIREMENTS }, docs: [], events: [], outcomes: new Map(), listeners: new Set() };
    names.forEach((fileName, i) => {
      const outcomes = sampleOutcomes(i);
      const vals = Object.values(outcomes);
      const verdict: Outcome = vals.includes("not_met") ? "not_met" : vals.includes("needs_review") ? "needs_review" : "met";
      r.docs.push({ docId: `d${String(i + 1).padStart(4, "0")}`, position: i, fileName, status: verdict, stage: null, attempt: 1, completedAt: new Date(Date.now() + i).toISOString() });
      r.outcomes.set(r.docs[i]!.docId, outcomes);
    });
    r.run.lastSeq = 1;
    runs.set(runId, r);
    return runId;
  };
  return { api, seedFiles, seedCompletedRun };
}
