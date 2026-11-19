/**
 * 문서 이동 모션. 복제 카드는 화면 전용(aria-hidden, 데이터에 추가하지 않음)이고, 좌표는 매번 현재 DOM에서 잰다.
 * 진행 중 이동이 많으면 시간을 줄이거나 생략해 화면이 최신 상태를 따라가게 한다. 애니메이션은 아무것도 기다리게 하지 않는다.
 */
import { useCallback, useRef } from "react";
import { usePrefersReducedMotion } from "./hooks";

export const TIMING = { toCenter: 400, toBin: 500, easing: "cubic-bezier(.2,.7,.2,1)" };

export type Tone = "neutral" | "met" | "not_met" | "needs_review";
const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-card",
  met: "border-met/50 bg-met-soft",
  not_met: "border-not-met/50 bg-not-met-soft",
  needs_review: "border-review/60 bg-review-soft",
};

export function useFlights() {
  const reduced = usePrefersReducedMotion();
  const active = useRef(0);
  return useCallback((from: DOMRect | undefined, to: DOMRect | undefined, label: string, duration: number, tone: Tone = "neutral"): Promise<boolean> => {
    if (reduced || !from || !to || active.current >= 4 || !from.width || !to.width) return Promise.resolve(false);
    const d = active.current >= 2 ? Math.round(duration / 2) : duration;
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.dataset.flight = "";
    el.className = `pointer-events-none fixed z-50 flex items-center overflow-hidden rounded-md border px-3 text-xs font-medium text-foreground shadow-md ${TONE_CLASS[tone]}`;
    Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    const span = document.createElement("span");
    span.className = "truncate";
    span.textContent = label;
    el.appendChild(span);
    document.body.appendChild(el);
    active.current++;
    const anim = el.animate(
      [
        { transform: "translate(0px, 0px)", width: `${from.width}px`, height: `${from.height}px` },
        { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px)`, width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: d, easing: TIMING.easing, fill: "forwards" },
    );
    return anim.finished.then(() => true, () => true).finally(() => { el.remove(); active.current--; });
  }, [reduced]);
}
