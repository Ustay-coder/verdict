/** 서버 계약(docs/verdict-review/spec.md §8, §10)과 같은 모양. */
export type Outcome = "met" | "not_met" | "needs_review";
export type DocStatus = "queued" | "reviewing" | Outcome | "error";
export type Stage = "reading" | "checking" | "saving";
export type RunStatus = "preparing" | "running" | "pausing" | "paused" | "completed" | "failed";

export interface FileView { id: string; name: string; status: "preparing" | "ready" | "error"; error?: string }
export interface DocView { docId: string; position: number; fileName: string; status: DocStatus; stage: Stage | null; attempt: number; error?: string; completedAt?: string | null }
export interface RunView { id: string; status: RunStatus; error: string | null; lastSeq: number; requirement: string; requirements: Array<{ id: string; text: string }> }
export interface RunSnapshot { run: RunView; docs: DocView[]; counts: Record<DocStatus, number> }

export interface Fact { label: string; value: string; quote: string; page: number; source: "text" | "ocr"; unitQuote?: string }
export interface RequirementResult { id: string; text: string; outcome: Outcome; reason: string; facts: Fact[]; rejected: Array<{ label: string; value: string; quote: string; reason: string }>; needed: string[]; judge: "formula" | "decision"; confidence?: number }
export interface DocResult { verdict: Outcome; evaluationId: string; requirements: RequirementResult[]; warnings: string[]; models: { facts: string; judge?: string } }
export interface DocDetail extends DocView { evaluationId: string | null; result: DocResult | null }

export interface RunEvent { seq: number; type: string; [k: string]: unknown }

export const OUTCOME_LABEL: Record<Outcome, string> = { met: "충족", not_met: "미충족", needs_review: "확인 필요" };
export const STAGE_LABEL: Record<Stage, string> = { reading: "내용 읽는 중", checking: "요건 확인 중", saving: "결과 저장 중" };
export const OUTCOMES: Outcome[] = ["met", "not_met", "needs_review"];
