import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FileItem } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export type Step = "requirement" | "upload" | "review";
const STEPS: Array<{ id: Step; label: string }> = [{ id: "requirement", label: "요건" }, { id: "upload", label: "서류" }, { id: "review", label: "검토" }];

/** 공통 상단: 서비스명 + 작은 단계 표시. 지나온 단계는 눌러서 돌아갈 수 있다. */
export function AppHeader({ step, reachable, onStep }: { step: Step; reachable: Step[]; onStep: (s: Step) => void }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <span className="text-sm font-semibold tracking-tight">Verdict 서류 검토</span>
        <nav aria-label="단계">
          <ol className="flex items-center gap-1 text-xs">
            {STEPS.map((s, i) => {
              const current = s.id === step;
              const can = !current && reachable.includes(s.id);
              return (
                <li key={s.id} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden className="text-muted-foreground/60">·</span>}
                  <button type="button" disabled={!can} aria-current={current ? "step" : undefined} onClick={() => onStep(s.id)}
                    className={cn("rounded px-1.5 py-0.5", current ? "font-semibold text-foreground" : "text-muted-foreground", can && "hover:text-foreground hover:underline", !can && !current && "cursor-default")}>
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
    </header>
  );
}

export function RequirementStep({ value, onChange, onNext }: { value: string; onChange: (v: string) => void; onNext: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const empty = value.trim().length === 0;
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6">
      <h1 className="text-xl font-semibold" id="req-title">요건 입력</h1>
      <Textarea ref={ref} aria-labelledby="req-title" value={value} maxLength={4000} onChange={(e) => onChange(e.target.value)}
        className="min-h-72 resize-y text-base leading-relaxed sm:min-h-80" />
      <div className="flex justify-end">
        <Button size="lg" disabled={empty} onClick={onNext}>다음</Button>
      </div>
    </section>
  );
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const open = () => input.current?.click();
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); };
  return (
    <>
    <div role="button" tabIndex={0} data-dropzone onClick={open} onKeyDown={onKey}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
      className={cn("flex min-h-40 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed bg-card px-6 text-sm text-muted-foreground transition-colors outline-none hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/50", over && "border-foreground/50 bg-accent text-foreground")}>
      파일을 끌어놓거나 클릭하세요
    </div>
    {/* 드롭 영역 밖에 둔다: input의 click이 영역으로 다시 올라가 선택창을 두 번 여는 일을 막는다. */}
    <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
    </>
  );
}

function FileRow({ item, onRemove, onRetry }: { item: FileItem; onRemove: () => void; onRetry: () => void }) {
  const canRetry = item.status === "error" && (item.errorKind === "prepare" || !!item.file);
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2" data-file-row={item.status}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={item.name}>{item.name}</div>
        {item.status === "error" && <div className="mt-0.5 truncate text-xs text-destructive" role="status" title={item.error}>{item.error}</div>}
        {item.status === "uploading" && (
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted" role="progressbar" aria-label={`${item.name} 전송`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
            <div className="h-full bg-foreground/60 transition-[width]" style={{ width: `${Math.max(4, item.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {item.status === "preparing" && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden />준비 중</span>}
      {item.status === "error" && canRetry && <Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onRetry}><RotateCw className="size-3" />재시도</Button>}
      <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={`${item.name} 삭제`} onClick={onRemove}><X className="size-4" /></Button>
    </li>
  );
}

export function UploadStep({ items, onAdd, onRemove, onRetry, onBack, onStart, starting, startError }: {
  items: FileItem[]; onAdd: (f: File[]) => void; onRemove: (key: string) => void; onRetry: (key: string) => void;
  onBack: () => void; onStart: () => void; starting: boolean; startError?: string | null;
}) {
  const ready = items.length > 0 && items.every((f) => f.status === "ready");
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6" aria-label="서류">
      <DropZone onFiles={onAdd} />
      {items.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card" aria-label="업로드된 서류">
          {items.map((f) => <FileRow key={f.key} item={f} onRemove={() => onRemove(f.key)} onRetry={() => onRetry(f.key)} />)}
        </ul>
      )}
      {startError && <p role="alert" className="text-sm text-destructive">{startError}</p>}
      <div className="flex justify-between">
        <Button variant="outline" size="lg" onClick={onBack}>이전</Button>
        <Button size="lg" disabled={!ready || starting} onClick={onStart}>검토 시작</Button>
      </div>
    </section>
  );
}
