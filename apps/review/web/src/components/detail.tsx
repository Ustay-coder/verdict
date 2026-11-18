import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ReviewApi } from "@/lib/api";
import type { DocItem } from "@/lib/run-state";
import { OUTCOME_LABEL, type DocDetail, type Outcome } from "@/lib/types";
import { cn } from "@/lib/utils";

export const TONE_TEXT: Record<Outcome, string> = { met: "text-met", not_met: "text-not-met", needs_review: "text-review" };
export const TONE_BG: Record<Outcome, string> = { met: "bg-met-soft text-met", not_met: "bg-not-met-soft text-not-met", needs_review: "bg-review-soft text-review" };
export const TONE_DOT: Record<Outcome, string> = { met: "bg-met", not_met: "bg-not-met", needs_review: "bg-review" };

export function OutcomeTag({ outcome, className }: { outcome: Outcome; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium", TONE_BG[outcome], className)}><span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[outcome])} />{OUTCOME_LABEL[outcome]}</span>;
}

/** 결과 상세: 요건별 판정·사유·확인한 사실(인용·쪽)·필요한 정보. 열려 있는 동안 검토가 계속돼도 이 문서를 유지한다. */
export function DetailSheet({ api, runId, doc, onClose }: { api: ReviewApi; runId: string; doc: DocItem | null; onClose: () => void }) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docId = doc?.docId;
  const status = doc?.status;
  useEffect(() => {
    if (!docId) return;
    let off = false;
    setDetail(null); setError(null);
    api.getDoc(runId, docId).then((d) => { if (!off) setDetail(d); }, (e: Error) => { if (!off) setError(e.message); });
    return () => { off = true; };
  }, [api, runId, docId, status]);

  const result = detail?.result;
  return (
    <Sheet open={!!doc} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-xl" data-detail>
        <SheetHeader className="border-b">
          <SheetTitle className="truncate pr-6" title={doc?.fileName}>{doc?.fileName}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex items-center gap-2">{result ? <><span>종합 판정</span><OutcomeTag outcome={result.verdict} /></> : doc?.status === "error" ? <span className="text-destructive">처리 오류</span> : <span>&nbsp;</span>}</div>
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {!detail && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />불러오는 중</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {detail?.status === "error" && <p className="text-sm text-destructive">{detail.error}</p>}
            {result?.warnings.map((w) => <p key={w} className="rounded-md bg-review-soft px-3 py-2 text-xs text-review">{w}</p>)}
            {result?.requirements.map((r) => (
              <article key={r.id} className="rounded-lg border bg-card p-3" aria-label={r.text}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-medium">{r.text}</h3>
                  <OutcomeTag outcome={r.outcome} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{r.reason}</p>
                {r.facts.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {r.facts.map((f, i) => (
                      <li key={i} className="rounded-md bg-muted px-2.5 py-1.5 text-xs">
                        <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-medium">{f.label}</span><span className="text-muted-foreground">{doc?.fileName} · {f.page}쪽{f.source === "ocr" ? " · 판독" : ""}</span></div>
                        <q className="mt-0.5 block break-words text-foreground/80">{f.quote}</q>
                        {f.unitQuote && <span className="text-muted-foreground">단위 표기: “{f.unitQuote}”</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {r.rejected.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">원문과 맞지 않아 제외한 값: {r.rejected.map((x) => `${x.label || "값"} ${x.value} (${x.reason})`).join(", ")}</p>
                )}
                {r.needed.length > 0 && (
                  <div className="mt-2 text-xs">
                    <span className="font-medium">필요한 정보</span>
                    <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">{r.needed.map((n) => <li key={n}>{n}</li>)}</ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
