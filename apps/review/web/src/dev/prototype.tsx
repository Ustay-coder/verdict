/**
 * UI 시안(개발용). 실제 화면 컴포넌트(App)를 그대로 쓰고 데이터만 모형 API로 바꾼다.
 * 상단의 노란 막대는 시안에서만 보이며, 여기의 진행·판정은 타이머와 예시 값이다(실제 검토 아님).
 */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { App, type Draft } from "../App";
import { createMockApi } from "./mock-api";
import { SAMPLE_REQUIREMENT, sampleFileNames } from "./fixtures";

type Scenario = { id: string; label: string; build: () => { api: ReturnType<typeof createMockApi>["api"]; initial: Partial<Draft>; detail?: string; drop?: string[] } };

const SCENARIOS: Scenario[] = [
  { id: "req-empty", label: "요건 입력 전", build: () => ({ api: createMockApi().api, initial: { step: "requirement" } }) },
  { id: "req-filled", label: "요건 입력 후", build: () => ({ api: createMockApi().api, initial: { step: "requirement", requirement: SAMPLE_REQUIREMENT } }) },
  { id: "upload-empty", label: "업로드 전", build: () => ({ api: createMockApi().api, initial: { step: "upload", requirement: SAMPLE_REQUIREMENT } }) },
  { id: "upload-files", label: "파일 있음", build: () => { const m = createMockApi(); return { api: m.api, initial: { step: "upload", requirement: SAMPLE_REQUIREMENT, files: m.seedFiles(sampleFileNames(6)) } }; } },
  {
    id: "upload-progress", label: "업로드 진행·오류", build: () => {
      const m = createMockApi({ uploadSpeed: 0.06, frozenPreparing: true });
      return { api: m.api, initial: { step: "upload", requirement: SAMPLE_REQUIREMENT, files: [...m.seedFiles(sampleFileNames(2)), ...m.seedFiles(["한빛기계_스캔본.pdf"], "preparing"), ...m.seedFiles(["손상된_파일.pdf"], "error", "PDF를 열 수 없습니다 (예시)")] }, drop: ["새봄푸드_신청서류.pdf", "온누리에너지_신청서류.pdf"] };
    },
  },
  { id: "review", label: "검토 시작·순차 검토", build: () => { const m = createMockApi(); return { api: m.api, initial: { step: "upload", requirement: SAMPLE_REQUIREMENT, files: m.seedFiles([...sampleFileNames(7), "미래로_오류예시.pdf"]) } }; } },
  { id: "review-fast", label: "빠른 처리(24건 ×6)", build: () => { const m = createMockApi({ speed: 6 }); return { api: m.api, initial: { step: "upload", requirement: SAMPLE_REQUIREMENT, files: m.seedFiles(sampleFileNames(24)) } }; } },
  { id: "detail", label: "결과 상세", build: () => { const m = createMockApi(); const runId = m.seedCompletedRun(sampleFileNames(14)); return { api: m.api, initial: { step: "review", requirement: SAMPLE_REQUIREMENT, runId }, detail: "d0003" }; } },
  { id: "done", label: "검토 완료", build: () => { const m = createMockApi(); const runId = m.seedCompletedRun(sampleFileNames(14)); return { api: m.api, initial: { step: "review", requirement: SAMPLE_REQUIREMENT, runId } }; } },
];

function Prototype() {
  const [id, setId] = useState(() => new URLSearchParams(location.search).get("s") ?? "req-empty");
  const [nonce, setNonce] = useState(0);
  const scenario = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
  const built = useMemo(() => scenario.build(), [scenario, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const url = new URL(location.href); url.searchParams.set("s", scenario.id); history.replaceState(null, "", url);
    // 시안: '검토 시작' 시나리오는 시작 버튼을 대신 누른다.
    if (scenario.id.startsWith("review")) {
      const t = setTimeout(() => document.querySelector<HTMLButtonElement>("main button:not([disabled])[class*='bg-primary']")?.click(), 400);
      return () => clearTimeout(t);
    }
    if (built.drop) {
      const t = setTimeout(() => {
        const dt = new DataTransfer();
        built.drop!.forEach((n) => dt.items.add(new File(["예시"], n, { type: "application/pdf" })));
        document.querySelector("[data-dropzone]")?.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
      }, 300);
      return () => clearTimeout(t);
    }
  }, [scenario, built]);

  return (
    <>
      <div className="sticky top-0 z-40 flex flex-wrap items-center gap-1.5 border-b border-amber-300 bg-amber-100 px-3 py-1.5 text-xs text-amber-950" data-prototype-bar>
        <span className="font-semibold">개발용 UI 시안 — 예시 데이터·타이머 진행 (실제 검토 아님)</span>
        {SCENARIOS.map((s) => (
          <button key={s.id} type="button" onClick={() => { setId(s.id); setNonce((n) => n + 1); }}
            className={`rounded border px-1.5 py-0.5 ${s.id === scenario.id ? "border-amber-900 bg-amber-900 text-amber-50" : "border-amber-400 bg-amber-50"}`}>{s.label}</button>
        ))}
      </div>
      <App key={`${scenario.id}-${nonce}`} api={built.api} storageKey="verdict-review:prototype" initial={built.initial} initialDetail={built.detail} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Prototype /></StrictMode>);
