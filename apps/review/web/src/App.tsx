import { useEffect, useMemo, useRef, useState } from "react";
import { AppHeader, RequirementStep, UploadStep, type Step } from "@/components/steps";
import { ReviewBoard } from "@/components/review-board";
import type { ReviewApi } from "@/lib/api";
import { useFiles } from "@/lib/hooks";

export interface Draft { step: Step; requirement: string; files: Array<{ id: string; name: string }>; runId: string | null }
const EMPTY: Draft = { step: "requirement", requirement: "", files: [], runId: null };

function loadDraft(key: string): Draft {
  try { const d = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null; return d ? { ...EMPTY, ...d } : EMPTY; } catch { return EMPTY; }
}

/**
 * 세 단계(요건 → 서류 → 검토). 요건·파일·실행 id는 브라우저 초안에 남아 새로고침 후에도 같은 단계로 돌아온다.
 * 검토 상태 자체는 서버에 있다(URL ?run=).
 */
export function App({ api, storageKey = "verdict-review:draft:v1", initial, initialDetail }: { api: ReviewApi; storageKey?: string; initial?: Partial<Draft>; initialDetail?: string }) {
  const saved = useMemo(() => {
    const d = initial ? { ...EMPTY, ...initial } : loadDraft(storageKey);
    const urlRun = new URLSearchParams(location.search).get("run");
    return urlRun && !initial ? { ...d, runId: urlRun, step: "review" as Step } : d;
  }, [storageKey, initial]);
  const [step, setStep] = useState<Step>(saved.step === "review" && !saved.runId ? "upload" : saved.step);
  const [requirement, setRequirement] = useState(saved.requirement);
  const [runId, setRunId] = useState<string | null>(saved.runId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const files = useFiles(api, saved.files);
  const startKey = useRef<string | null>(null);

  useEffect(() => {
    const draft: Draft = { step, requirement, runId, files: files.items.filter((f) => f.id).map((f) => ({ id: f.id!, name: f.name })) };
    try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* 저장 공간 없음: 초안 유지는 생략 */ }
  }, [step, requirement, runId, files.items, storageKey]);

  useEffect(() => {
    if (initial) return;
    const url = new URL(location.href);
    if (step === "review" && runId) url.searchParams.set("run", runId); else url.searchParams.delete("run");
    history.replaceState(null, "", url);
  }, [step, runId, initial]);

  // 단계 전환 시 본문 첫 컨트롤로 포커스(요건 단계는 입력창이 스스로 포커스).
  useEffect(() => { if (step === "upload") document.querySelector<HTMLElement>("[data-dropzone]")?.focus(); }, [step]);

  const start = async () => {
    setStarting(true); setStartError(null);
    startKey.current ??= crypto.randomUUID();
    try {
      const snap = await api.startRun(requirement.trim(), files.items.map((f) => f.id!), startKey.current);
      startKey.current = null;
      setRunId(snap.run.id);
      setStep("review");
    } catch (e) { setStartError((e as Error).message); } finally { setStarting(false); }
  };

  const reachable: Step[] = ["requirement", ...(requirement.trim() ? (["upload"] as Step[]) : []), ...(runId ? (["review"] as Step[]) : [])];

  return (
    <div className="min-h-dvh">
      <AppHeader step={step} reachable={reachable} onStep={setStep} />
      <main>
        {step === "requirement" && <RequirementStep value={requirement} onChange={setRequirement} onNext={() => setStep("upload")} />}
        {step === "upload" && (
          <UploadStep items={files.items} onAdd={files.add} onRemove={files.remove} onRetry={files.retry}
            onBack={() => setStep("requirement")} onStart={start} starting={starting} startError={startError} />
        )}
        {step === "review" && runId && <ReviewBoard key={runId} api={api} runId={runId} initialDetail={initialDetail} />}
      </main>
    </div>
  );
}
