import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, Loader2, Pause, Play, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DetailSheet, OutcomeTag, TONE_DOT } from "@/components/detail";
import type { ReviewApi } from "@/lib/api";
import { TIMING, useFlights } from "@/lib/flights";
import { useRun } from "@/lib/hooks";
import { binDocs, countsOf, type DocItem, type RunState } from "@/lib/run-state";
import { OUTCOME_LABEL, OUTCOMES, STAGE_LABEL, type Outcome, type RunEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const RECENT = 5;
const ARRIVE_COLOR: Record<Outcome, string> = { met: "var(--met-soft)", not_met: "var(--not-met-soft)", needs_review: "var(--review-soft)" };
/** 브라우저가 레이아웃을 마친 뒤(React 커밋 이후) 실행. */
const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

export function ReviewBoard({ api, runId, initialDetail }: { api: ReviewApi; runId: string; initialDetail?: string }) {
  const board = useRef<HTMLDivElement>(null);
  const pileTop = useRef<HTMLDivElement>(null);
  const center = useRef<HTMLDivElement>(null);
  const fly = useFlights();
  const [arriving, setArriving] = useState<string | null>(null);
  const [landing, setLanding] = useState<Set<string>>(new Set());
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(initialDetail ?? null);
  const [bin, setBin] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, on: boolean) => set((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  /** 실제 저장 이벤트에만 모션을 붙인다. 데이터는 이미 반영돼 있고, 모션은 무엇도 기다리게 하지 않는다. */
  const onLive = useCallback((e: RunEvent, next: RunState) => {
    const id = e.docId as string | undefined;
    const doc = id ? next.docs.find((d) => d.docId === id) : undefined;
    if (!doc) return;
    if (e.type === "doc.started") {
      const from = pileTop.current?.getBoundingClientRect();
      setArriving(id!);
      afterPaint(() => { void fly(from, center.current?.getBoundingClientRect(), doc.fileName, TIMING.toCenter).then(() => setArriving((a) => (a === id ? null : a))); });
    } else if (e.type === "doc.completed") {
      const from = center.current?.getBoundingClientRect();
      const verdict = e.verdict as Outcome;
      toggle(setLanding, id!, true);
      afterPaint(() => {
        const row = board.current?.querySelector(`[data-doc-row="${id}"]`) as HTMLElement | null;
        void fly(from, row?.getBoundingClientRect(), doc.fileName, TIMING.toBin, verdict).then(() => {
          toggle(setLanding, id!, false);
          toggle(setArrived, id!, true);
          setTimeout(() => toggle(setArrived, id!, false), 800);
        });
      });
    }
  }, [fly]);

  const { state, loadError, adopt } = useRun(api, runId, onLive);

  const control = async (fn: () => Promise<Parameters<typeof adopt>[0]>) => {
    setBusy(true); setActionError(null);
    try { adopt(await fn()); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  };

  const docs = state?.docs ?? [];
  const queued = useMemo(() => docs.filter((d) => d.status === "queued"), [docs]);
  const errors = useMemo(() => docs.filter((d) => d.status === "error"), [docs]);
  const current = docs.find((d) => d.status === "reviewing") ?? null;
  const counts = countsOf(docs);
  const selectedDoc = docs.find((d) => d.docId === selected) ?? null;

  useEffect(() => { if (initialDetail) setSelected(initialDetail); }, [initialDetail]);

  if (!state) {
    return <div className="flex justify-center py-24 text-sm text-muted-foreground">{loadError ? <span className="text-destructive">{loadError}</span> : <Loader2 className="size-5 animate-spin" aria-label="불러오는 중" />}</div>;
  }
  const { run } = state;
  const done = counts.met + counts.not_met + counts.needs_review;

  return (
    <section ref={board} className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)_340px] lg:gap-6 lg:py-10" aria-label="검토">
      {/* 대기 더미 */}
      <div className="flex flex-col gap-3" data-area="pile">
        <h2 className="text-xs font-medium text-muted-foreground">대기</h2>
        <div className="relative h-28" aria-live="polite">
          {queued.length === 0 ? (
            <div ref={pileTop} className="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">대기 문서 없음</div>
          ) : (
            <>
              {queued.slice(1, 5).map((d, i) => (
                <div key={d.docId} aria-hidden className="absolute inset-x-0 h-24 rounded-lg border bg-card shadow-xs" style={{ top: `${(i + 1) * 5}px`, left: `${(i + 1) * 4}px`, right: `${(i + 1) * 4}px`, zIndex: 10 - i, opacity: 1 - (i + 1) * 0.15 }} />
              ))}
              <div ref={pileTop} data-pile-top className="absolute inset-x-0 top-0 z-20 flex h-24 flex-col justify-center rounded-lg border bg-card px-3 shadow-sm">
                <span className="text-[11px] text-muted-foreground">다음</span>
                <span className="truncate text-sm font-medium" title={queued[0]!.fileName}>{queued[0]!.fileName}</span>
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">대기 {queued.length}</p>
        {errors.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-card p-2" data-area="errors">
            <h3 className="px-1 pb-1 text-xs font-medium text-destructive">처리 오류 {errors.length}</h3>
            <ul className="space-y-1">
              {errors.map((d) => (
                <li key={d.docId} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
                  <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" title={d.error} onClick={() => setSelected(d.docId)}>{d.fileName}</button>
                  <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => control(() => api.retryDoc(run.id, d.docId))}><RotateCw className="size-3" />재시도</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 현재 문서 */}
      <div className="flex flex-col gap-3" data-area="center">
        <h2 className="text-xs font-medium text-muted-foreground">현재 문서</h2>
        <Card ref={center} data-center-slot className="min-h-56 gap-0 p-5">
          <CenterContent run={run} doc={current} hidden={!!current && arriving === current.docId} done={done} total={docs.length} errors={counts.error}
            onRetryRun={() => control(() => api.retryRun(run.id))} busy={busy} />
        </Card>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">{run.status === "paused" ? "일시정지됨" : run.status === "pausing" ? "현재 문서를 저장한 뒤 멈춥니다" : ""}</span>
          {run.status === "running" && <Button variant="outline" size="sm" disabled={busy} onClick={() => control(() => api.pause(run.id))}><Pause className="size-3.5" />일시정지</Button>}
          {run.status === "pausing" && <Button variant="outline" size="sm" disabled><Loader2 className="size-3.5 animate-spin" />일시정지 중</Button>}
          {run.status === "paused" && <Button size="sm" disabled={busy} onClick={() => control(() => api.resume(run.id))}><Play className="size-3.5" />재개</Button>}
        </div>
        {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
      </div>

      {/* 결과 영역 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1" data-area="bins">
        {OUTCOMES.map((o) => {
          const list = binDocs(docs, o);
          return (
            <Card key={o} className="gap-0 p-0" data-bin={o} aria-label={`${OUTCOME_LABEL[o]} ${list.length}건`}>
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="flex items-center gap-1.5 text-sm font-medium"><span aria-hidden className={cn("size-2 rounded-full", TONE_DOT[o])} />{OUTCOME_LABEL[o]}</span>
                <span className="text-sm tabular-nums" aria-live="polite">{list.length}</span>
              </div>
              <ul className="min-h-10 p-1">
                {list.slice(0, RECENT).map((d) => (
                  <li key={d.docId}>
                    <button type="button" data-doc-row={d.docId} onClick={() => setSelected(d.docId)}
                      style={{ "--arrive-color": ARRIVE_COLOR[o] } as CSSProperties}
                      className={cn("block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none", landing.has(d.docId) && "opacity-0", arrived.has(d.docId) && "arrived")}
                      title={d.fileName}>{d.fileName}</button>
                  </li>
                ))}
              </ul>
              {list.length > RECENT && <Button variant="ghost" size="sm" className="m-1 mt-0 h-7 justify-start text-xs text-muted-foreground" onClick={() => setBin(o)}>전체 보기</Button>}
            </Card>
          );
        })}
      </div>

      <Sheet open={!!bin} onOpenChange={(o) => { if (!o) setBin(null); }}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          <SheetHeader className="border-b"><SheetTitle>{bin ? OUTCOME_LABEL[bin] : ""}</SheetTitle><SheetDescription>{bin ? `${binDocs(docs, bin).length}건` : ""}</SheetDescription></SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="p-2">{bin && binDocs(docs, bin).map((d) => (
              <li key={d.docId}><button type="button" className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent" title={d.fileName} onClick={() => { setBin(null); setSelected(d.docId); }}>{d.fileName}</button></li>
            ))}</ul>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <DetailSheet api={api} runId={run.id} doc={selectedDoc} onClose={() => setSelected(null)} />
    </section>
  );
}

function CenterContent({ run, doc, hidden, done, total, errors, onRetryRun, busy }: { run: RunState["run"]; doc: DocItem | null; hidden: boolean; done: number; total: number; errors: number; onRetryRun: () => void; busy: boolean }) {
  if (doc) {
    return (
      <div className={cn("flex flex-col gap-4 transition-opacity", hidden && "opacity-0")} data-current={doc.docId}>
        <div>
          <p className="truncate text-base font-semibold" title={doc.fileName}>{doc.fileName}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite"><Loader2 className="size-3.5 animate-spin" aria-hidden />{doc.stage ? STAGE_LABEL[doc.stage] : "준비 중"}</p>
        </div>
        <ul className="space-y-1.5" aria-label="요건별 결과">
          {run.requirements.map((r) => {
            const o = doc.outcomes[r.id];
            return (
              <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-foreground/80" title={r.text}>{r.text}</span>
                {o ? <OutcomeTag outcome={o} /> : <span aria-label="확인 전" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  if (run.status === "preparing") return <Placeholder><Loader2 className="size-4 animate-spin" aria-hidden />요건 해석 중</Placeholder>;
  if (run.status === "failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
        <p className="text-sm text-destructive">{run.error ?? "검토를 시작하지 못했습니다"}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={onRetryRun}><RotateCw className="size-3.5" />재시도</Button>
      </div>
    );
  }
  if (run.status === "completed") {
    return <Placeholder><CheckCircle2 className="size-5 text-met" aria-hidden /><span className="font-medium text-foreground">검토 완료</span><span className="text-muted-foreground">{done}/{total}{errors ? ` · 오류 ${errors}` : ""}</span></Placeholder>;
  }
  if (run.status === "paused") return <Placeholder>일시정지됨</Placeholder>;
  return <Placeholder><Loader2 className="size-4 animate-spin" aria-hidden />다음 문서 준비 중</Placeholder>;
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-44 flex-col items-center justify-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">{children}</div>;
}
