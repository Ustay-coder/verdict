/**
 * 검토 화면 상태. 서버 스냅샷 + 저장된 이벤트만으로 만든다. 건수는 항상 문서 상태에서 계산(증가 연산 없음)하고,
 * 이미 반영한 seq의 이벤트는 무시해 재전송·재연결로 중복되지 않는다.
 */
import type { DocStatus, DocView, Outcome, RunEvent, RunSnapshot, RunView, Stage } from "./types";

export interface DocItem extends DocView { outcomes: Record<string, Outcome> }
export interface RunState { run: RunView; docs: DocItem[]; applied: number }

export function fromSnapshot(s: RunSnapshot): RunState {
  return { run: s.run, docs: s.docs.map((d) => ({ ...d, outcomes: {} })), applied: s.run.lastSeq };
}

function patchDoc(state: RunState, docId: unknown, fn: (d: DocItem) => DocItem): DocItem[] {
  return state.docs.map((d) => (d.docId === docId ? fn(d) : d));
}

export function applyEvent(state: RunState, e: RunEvent): RunState {
  if (e.seq <= state.applied) return state;
  const next: RunState = { ...state, applied: e.seq, run: { ...state.run, lastSeq: e.seq } };
  switch (e.type) {
    case "run.status":
      next.run = { ...next.run, status: e.status as RunView["status"], error: (e.error as string) ?? null, ...(Array.isArray(e.requirements) ? { requirements: e.requirements as RunView["requirements"] } : {}) };
      return next;
    case "doc.started":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, status: "reviewing", stage: "reading", outcomes: {}, error: undefined, attempt: (e.attempt as number) ?? d.attempt }));
      return next;
    case "doc.stage":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, stage: e.stage as Stage }));
      return next;
    case "doc.requirement":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, outcomes: { ...d.outcomes, [e.requirementId as string]: e.outcome as Outcome } }));
      return next;
    case "doc.completed":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, status: e.verdict as DocStatus, stage: null, completedAt: new Date().toISOString() }));
      return next;
    case "doc.failed":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, status: "error", stage: null, error: e.error as string }));
      return next;
    case "doc.requeued":
      next.docs = patchDoc(state, e.docId, (d) => ({ ...d, status: "queued", stage: null, outcomes: {}, error: undefined }));
      return next;
    default:
      return next;
  }
}

export function countsOf(docs: DocItem[]): Record<DocStatus, number> {
  const c: Record<DocStatus, number> = { queued: 0, reviewing: 0, met: 0, not_met: 0, needs_review: 0, error: 0 };
  for (const d of docs) c[d.status]++;
  return c;
}

/** 결과 영역 목록: 최근 완료 순(같으면 순서 역순). */
export function binDocs(docs: DocItem[], outcome: Outcome): DocItem[] {
  return docs.filter((d) => d.status === outcome).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || b.position - a.position);
}
