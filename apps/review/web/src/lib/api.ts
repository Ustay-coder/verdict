/**
 * 화면이 쓰는 서버 기능. 운영 화면은 httpApi(실제 서버)를, 개발용 UI 시안은 src/dev/mock-api.ts를 쓴다.
 */
import type { DocDetail, FileView, RunEvent, RunSnapshot } from "./types";

export interface Subscription { close(): void }

export interface ReviewApi {
  /** 파일 전송. onProgress(0..1)는 실제 전송 바이트 기준. */
  uploadFile(file: File, onProgress: (p: number) => void): Promise<FileView>;
  getFiles(ids: string[]): Promise<FileView[]>;
  prepareFile(id: string): Promise<FileView>;
  deleteFile(id: string): Promise<void>;
  startRun(requirement: string, fileIds: string[], idempotencyKey: string): Promise<RunSnapshot>;
  getRun(id: string): Promise<RunSnapshot>;
  getDoc(runId: string, docId: string): Promise<DocDetail>;
  /** seq가 after보다 큰 저장된 이벤트부터 받는다. 끊기면 onBroken. */
  subscribe(runId: string, after: number, onEvent: (e: RunEvent) => void, onBroken: () => void): Subscription;
  pause(runId: string): Promise<RunSnapshot>;
  resume(runId: string): Promise<RunSnapshot>;
  retryDoc(runId: string, docId: string): Promise<RunSnapshot>;
  retryRun(runId: string): Promise<RunSnapshot>;
}

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(body.error?.message ?? `요청 실패 (${res.status})`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const EVENT_TYPES = ["run.status", "doc.started", "doc.stage", "doc.requirement", "doc.completed", "doc.failed", "doc.requeued"] as const;

export const httpApi: ReviewApi = {
  uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let body: { error?: { message?: string } } & Partial<FileView> = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* 빈 응답 */ }
        if (xhr.status === 201) resolve(body as FileView);
        else reject(new ApiError(body.error?.message ?? `전송 실패 (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError("전송 실패", 0));
      const form = new FormData();
      form.set("file", file);
      xhr.send(form);
    });
  },
  getFiles: async (ids) => (ids.length ? (await call<{ data: FileView[] }>(`/api/files?ids=${ids.map(encodeURIComponent).join(",")}`)).data : []),
  prepareFile: (id) => call(`/api/files/${id}/prepare`, { method: "POST" }),
  deleteFile: (id) => call(`/api/files/${id}`, { method: "DELETE" }),
  startRun: (requirement, fileIds, key) => call("/api/runs", { method: "POST", body: JSON.stringify({ requirement, fileIds }), headers: { "idempotency-key": key } }),
  getRun: (id) => call(`/api/runs/${id}`),
  getDoc: (runId, docId) => call(`/api/runs/${runId}/docs/${docId}`),
  subscribe(runId, after, onEvent, onBroken) {
    // EventSource는 끊기면 Last-Event-ID로 스스로 이어 받는다. 연속 실패면 스냅샷부터 다시.
    const es = new EventSource(`/api/runs/${runId}/events?after=${after}`);
    let failures = 0;
    const handler = (e: MessageEvent) => { failures = 0; onEvent({ ...(JSON.parse(e.data) as RunEvent), type: e.type }); };
    for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener);
    es.addEventListener("ping", () => { failures = 0; });
    es.onerror = () => { if (++failures >= 2) { es.close(); onBroken(); } };
    return { close: () => es.close() };
  },
  pause: (id) => call(`/api/runs/${id}/pause`, { method: "POST" }),
  resume: (id) => call(`/api/runs/${id}/resume`, { method: "POST" }),
  retryDoc: (id, docId) => call(`/api/runs/${id}/docs/${docId}/retry`, { method: "POST" }),
  retryRun: (id) => call(`/api/runs/${id}/retry`, { method: "POST" }),
};
