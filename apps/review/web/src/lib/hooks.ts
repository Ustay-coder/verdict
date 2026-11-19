import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewApi } from "./api";
import { applyEvent, fromSnapshot, type RunState } from "./run-state";
import type { FileView, RunEvent } from "./types";

export function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * 실행 상태: 스냅샷을 읽고 그 lastSeq 이후의 저장된 이벤트를 구독한다. 이벤트가 상태를 바꿨을 때만
 * onLive를 부른다(모션용). 재연결은 스냅샷부터 다시 — 이때는 모션 없이 최신 상태로 맞춘다.
 */
export function useRun(api: ReviewApi, runId: string | null, onLive?: (e: RunEvent, next: RunState) => void) {
  const [state, setState] = useState<RunState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const ref = useRef<RunState | null>(null);
  const live = useRef(onLive);
  live.current = onLive;

  const replace = useCallback((s: RunState) => { ref.current = s; setState(s); }, []);

  useEffect(() => {
    if (!runId) { ref.current = null; setState(null); return; }
    let cancelled = false;
    let sub: { close(): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const snap = await api.getRun(runId);
        if (cancelled) return;
        setLoadError(null);
        replace(fromSnapshot(snap));
        sub = api.subscribe(runId, snap.run.lastSeq, (e) => {
          const prev = ref.current;
          if (!prev) return;
          const next = applyEvent(prev, e);
          if (next === prev) return;
          replace(next);
          live.current?.(e, next);
        }, () => { sub?.close(); if (!cancelled) timer = setTimeout(connect, 1000); });
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as Error).message);
        timer = setTimeout(connect, 3000);
      }
    };
    void connect();
    return () => { cancelled = true; sub?.close(); clearTimeout(timer); };
  }, [api, runId, replace]);

  /** 제어 API 응답(스냅샷)으로 즉시 맞춘다. 더 최신 이벤트를 이미 반영했다면 무시. */
  const adopt = useCallback((snap: Parameters<typeof fromSnapshot>[0]) => {
    if (!ref.current || snap.run.lastSeq > ref.current.applied) replace(fromSnapshot(snap));
  }, [replace]);

  return { state, loadError, adopt };
}

export type FileItemStatus = "uploading" | "preparing" | "ready" | "error";
export interface FileItem { key: string; name: string; id?: string; status: FileItemStatus; progress: number; error?: string; errorKind?: "upload" | "prepare"; file?: File }

let keySeq = 0;
const newKey = () => `f${Date.now().toString(36)}${(keySeq++).toString(36)}`;
const UPLOAD_CONCURRENCY = 3;

/** 업로드 목록. 단계 이동과 무관하게 App에 머문다. 준비 중 파일은 1초마다 상태를 조회한다. */
export function useFiles(api: ReviewApi, initial: Array<{ id: string; name: string }>) {
  const [items, setItems] = useState<FileItem[]>(() => initial.map((f) => ({ key: newKey(), id: f.id, name: f.name, status: "preparing" as const, progress: 1 })));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const active = useRef(0);
  const started = useRef(new Set<string>());
  const update = useCallback((key: string, patch: Partial<FileItem>) => setItems((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f))), []);

  const pump = useCallback(() => {
    for (const item of itemsRef.current) {
      if (active.current >= UPLOAD_CONCURRENCY) break;
      if (item.status !== "uploading" || item.id || !item.file || started.current.has(item.key)) continue;
      started.current.add(item.key);
      active.current++;
      api.uploadFile(item.file, (p) => update(item.key, { progress: p }))
        .then((view) => update(item.key, fromView(view)))
        .catch((e: Error) => update(item.key, { status: "error", errorKind: "upload", error: e.message || "전송 실패" }))
        .finally(() => { active.current--; setTimeout(pump, 0); });
    }
  }, [api, update]);

  useEffect(() => { pump(); }, [items, pump]);

  // 새로고침 후 복구: 서버에 있는 파일 상태로 맞추고, 없는 파일은 다시 올리도록 표시.
  useEffect(() => {
    const ids = initial.map((f) => f.id);
    if (!ids.length) return;
    api.getFiles(ids).then((views) => {
      const byId = new Map(views.map((v) => [v.id, v]));
      setItems((list) => list.map((f) => {
        if (!f.id || !ids.includes(f.id)) return f;
        const v = byId.get(f.id);
        return v ? { ...f, ...fromView(v) } : { ...f, status: "error", errorKind: "upload", error: "다시 올려 주세요" };
      }));
    }).catch(() => {});
    // 최초 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preparing = items.some((f) => f.status === "preparing" && f.id);
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(() => {
      const ids = itemsRef.current.filter((f) => f.status === "preparing" && f.id).map((f) => f.id!);
      api.getFiles(ids).then((views) => {
        const byId = new Map(views.map((v) => [v.id, v]));
        setItems((list) => list.map((f) => (f.id && byId.has(f.id) && f.status === "preparing" ? { ...f, ...fromView(byId.get(f.id)!) } : f)));
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [api, preparing]);

  const add = useCallback((files: File[]) => {
    setItems((list) => [...list, ...files.map((file) => ({ key: newKey(), name: file.name, status: "uploading" as const, progress: 0, file }))]);
  }, []);
  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((f) => f.key === key);
    setItems((list) => list.filter((f) => f.key !== key));
    if (item?.id) api.deleteFile(item.id).catch(() => {});
  }, [api]);
  const retry = useCallback((key: string) => {
    const item = itemsRef.current.find((f) => f.key === key);
    if (!item) return;
    if (item.errorKind === "prepare" && item.id) {
      update(key, { status: "preparing", error: undefined });
      api.prepareFile(item.id).then((v) => update(key, fromView(v))).catch((e: Error) => update(key, { status: "error", errorKind: "prepare", error: e.message }));
    } else if (item.file) {
      setItems((list) => list.map((f) => (f.key === key ? { key: newKey(), name: f.name, file: f.file, status: "uploading", progress: 0 } : f)));
    }
  }, [api, update]);

  return { items, add, remove, retry };
}

function fromView(v: FileView): Partial<FileItem> {
  return { id: v.id, name: v.name, status: v.status, progress: 1, error: v.error, errorKind: v.status === "error" ? "prepare" : undefined };
}
