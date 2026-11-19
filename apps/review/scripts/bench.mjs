/**
 * 실제 처리 시간 측정(실제 OCR·LLM·Verdict/Jev 호출). 값이 서로 다른 가상 회사 서류 N건을 만들어
 * 업로드 → 준비 → 검토를 끝까지 돌리고, 단계별 시간과 기대 판정 일치율을 출력한다.
 *   NODE_USE_ENV_PROXY=1 node apps/review/scripts/bench.mjs [건수=100] [스캔 비율=0.1]
 * 비용이 드는 실호출이다. 데이터는 임시 디렉터리에 저장된다.
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const N = Number(process.argv[2] ?? 100);
const SCAN_RATIO = Number(process.argv[3] ?? 0.1);
const work = mkdtempSync(join(tmpdir(), "review-bench-"));
const docsDir = join(work, "docs");
mkdirSync(docsDir);
process.env.REVIEW_DATA_DIR ??= join(work, "data");
process.env.PORT ??= "8798";
process.env.OPENAI_API_KEY ??= "sk-proxy-injected";

/* ---------- 서류 생성(정답 포함) ---------- */
let seed = 20261119;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rand() * a.length)];
const CITIES = [["울산광역시 남구 삼산로", true], ["울산광역시 중구 종가로", true], ["울산광역시 북구 산업로", true], ["울산광역시 울주군 언양읍 중앙로", true], ["부산광역시 해운대구 센텀중앙로", false], ["서울특별시 강남구 테헤란로", false], ["대구광역시 수성구 달구벌대로", false]];
const NAMES = ["가온", "누리", "다솜", "라온", "마루", "바름", "새봄", "아라", "자람", "차오", "하늘", "한빛", "온새", "이음", "푸름", "별빛", "단비", "미르", "보람", "나래"];
const SUFFIX = ["테크", "솔루션", "기계", "바이오", "푸드", "물산", "에너지", "정밀", "소재", "로보틱스"];
const pad = (n) => String(n).padStart(2, "0");
const kor = (d) => `${d.slice(0, 4)} 년 ${d.slice(5, 7)} 월 ${d.slice(8, 10)} 일`;
const won = (n) => `${n.toLocaleString("en-US")}원`;

function makeCase(i) {
  const name = `주식회사 ${pick(NAMES)}${pick(SUFFIX)}`;
  const r = rand();
  const open = r < 0.08 ? "2022-12-31" : r < 0.12 ? "2023-01-01" : `${2012 + Math.floor(rand() * 14)}-${pad(1 + Math.floor(rand() * 12))}-${pad(1 + Math.floor(rand() * 28))}`;
  const [addr, ulsan] = pick(CITIES);
  const rr = rand();
  const revenue = rr < 0.15 ? null : rr < 0.22 ? 100_000_000 : rr < 0.27 ? 99_999_999 : Math.round((10 + rand() * 2000) * 1e6 / 1000) * 1000;
  const scan = i % Math.round(1 / SCAN_RATIO) === 0;
  const unit = scan && revenue !== null && revenue % 1000 === 0 && rand() < 0.5;
  const tri = (b) => (b ? 2 : 0);
  const c1 = tri(open <= "2022-12-31"), c2 = tri(ulsan), c3 = revenue === null ? 1 : tri(revenue >= 100_000_000);
  const expected = ["not_met", "needs_review", "met"][Math.min(c1, c2, c3)];
  return { file: `${String(i + 1).padStart(3, "0")}_${name.replace("주식회사 ", "")}${scan ? "_스캔" : ""}.pdf`, name, open, addr: `${addr} ${1 + Math.floor(rand() * 200)}`, revenue, scan, unit, expected };
}
const css = `body{font-family:"Noto Sans CJK KR",sans-serif;font-size:15px;margin:48px;color:#111} h1{font-size:24px;text-align:center;letter-spacing:8px} table{border-collapse:collapse;width:100%;margin-top:16px} td{border:1px solid #333;padding:8px} .p{page-break-after:always}`;
const html = (c) => `<div class="p"><h1>사업자등록증</h1><table><tr><td>법인명(단체명)</td><td>${c.name}</td></tr><tr><td>개업연월일</td><td>${kor(c.open)}</td></tr><tr><td>사업장 소재지</td><td>${c.addr}</td></tr></table><p style="text-align:right;margin-top:40px">(가상 예시 문서)</p></div>`
  + (c.revenue === null ? `<div><h1>사업계획서</h1><p>${c.name}는 지역 제조기업을 위한 설비 관리 서비스를 준비하고 있습니다.</p></div>`
    : `<div><h1>손익계산서</h1><p>2025년 1월 1일부터 2025년 12월 31일까지</p>${c.unit ? `<p style="text-align:right">(단위: 천원)</p>` : ""}<table><tr><td>과목</td><td>2025년(당기)</td></tr><tr><td>Ⅰ. 매출액</td><td>${c.unit ? (c.revenue / 1000).toLocaleString("en-US") : won(c.revenue)}</td></tr></table></div>`);

const cases = Array.from({ length: N }, (_, i) => makeCase(i));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const c of cases) {
  if (!c.scan) { await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${html(c)}`); writeFileSync(join(docsDir, c.file), await page.pdf({ format: "A4" })); continue; }
  const shots = [];
  for (const part of html(c).split(/(?=<div>)/)) {
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${part}`);
    shots.push((await page.screenshot({ type: "png" })).toString("base64"));
  }
  await page.setContent(`<!doctype html><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block;filter:grayscale(1)}</style>${shots.map((s) => `<img src="data:image/png;base64,${s}">`).join("")}`);
  writeFileSync(join(docsDir, c.file), await page.pdf({ format: "A4", printBackground: true }));
}
await browser.close();
console.log(`[gen] ${N}건 생성 (스캔 ${cases.filter((c) => c.scan).length}) → ${docsDir}`);

/* ---------- 측정 ---------- */
const { startReviewServer } = await import("../server/dist/main.js");
const { server, runner, repo } = await startReviewServer();
const base = `http://localhost:${process.env.PORT}`;
const REQ = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";
const t0 = Date.now();
const ids = await Promise.all(cases.map(async (c) => {
  const form = new FormData();
  form.set("file", new File([readFileSync(join(docsDir, c.file))], c.file, { type: "application/pdf" }));
  return (await (await fetch(`${base}/api/files`, { method: "POST", body: form })).json()).id;
}));
const tUploaded = Date.now();
let files;
for (;;) {
  files = (await (await fetch(`${base}/api/files?ids=${ids.join(",")}`)).json()).data;
  if (files.every((f) => f.status !== "preparing")) break;
  await new Promise((r) => setTimeout(r, 500));
}
const tPrepared = Date.now();
const failedPrep = files.filter((f) => f.status !== "ready");
const snap = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requirement: REQ, fileIds: files.filter((f) => f.status === "ready").map((f) => f.id) }) })).json();
const runId = snap.run.id;
let run;
for (;;) {
  run = await (await fetch(`${base}/api/runs/${runId}`)).json();
  if (["completed", "failed"].includes(run.run.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const tDone = Date.now();

/* ---------- 집계 ---------- */
const sec = (a, b) => (new Date(b) - new Date(a)) / 1000;
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return s.length ? `n=${s.length} 평균 ${(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2)}s · 중앙 ${q(0.5).toFixed(2)}s · p90 ${q(0.9).toFixed(2)}s · 최대 ${s.at(-1).toFixed(2)}s` : "없음"; };
const fileRows = repo.db.prepare(`SELECT name, created_at, updated_at, extraction_json FROM files WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
const prepText = [], prepScan = [];
for (const f of fileRows) if (f.extraction_json) ((JSON.parse(f.extraction_json).pages.some((p) => p.source === "ocr")) ? prepScan : prepText).push(sec(f.created_at, f.updated_at));
const events = repo.listEvents(runId, 0, 100_000);
const at = (pred) => events.find(pred)?.createdAt;
const compile = sec(at((e) => e.type === "run.status" && e.payload.status === "preparing"), at((e) => e.type === "run.status" && e.payload.status === "running"));
const reading = [], checking = [], total = [], gaps = [];
let prevDone;
for (const d of repo.listDocs(runId)) {
  const mine = events.filter((e) => e.payload.docId === d.docId);
  const s = mine.find((e) => e.type === "doc.started"), c = mine.find((e) => e.type === "doc.stage" && e.payload.stage === "checking"), v = mine.find((e) => e.type === "doc.stage" && e.payload.stage === "saving"), done = mine.find((e) => e.type === "doc.completed" || e.type === "doc.failed");
  if (s && c) reading.push(sec(s.createdAt, c.createdAt));
  if (c && v) checking.push(sec(c.createdAt, v.createdAt));
  if (s && done) total.push(sec(s.createdAt, done.createdAt));
  if (prevDone && s) gaps.push(sec(prevDone, s.createdAt));
  prevDone = done?.createdAt;
}
const runSpan = sec(at((e) => e.type === "doc.started"), at((e) => e.type === "run.status" && e.payload.status === "completed"));
const byFile = Object.fromEntries(run.docs.map((d) => [d.fileName, d.status]));
const mismatches = cases.filter((c) => byFile[c.file] && byFile[c.file] !== c.expected);
console.log(`
[결과] ${N}건 · 요건 3개 · 추출 ${process.env.REVIEW_LLM_MODEL ?? "gpt-5.4-mini"} · 서술형 판정 Jev
업로드(동시 전송)        ${((tUploaded - t0) / 1000).toFixed(1)}s
준비 완료까지(벽시계)     ${((tPrepared - t0) / 1000).toFixed(1)}s   ← 업로드 시작부터 모든 파일 준비 완료
  준비: 텍스트 PDF        ${stats(prepText)}
  준비: 스캔 PDF(OCR)     ${stats(prepScan)}
  준비 실패               ${failedPrep.length}건 ${failedPrep.map((f) => `${f.name}: ${f.error}`).join(", ")}
요건 해석(실행당 1회)     ${compile.toFixed(1)}s
검토(첫 문서 시작~완료)   ${runSpan.toFixed(1)}s  → 처리량 ${(run.docs.length / (runSpan / 60)).toFixed(1)}건/분
  문서 1건 전체           ${stats(total)}
    내용 읽는 중          ${stats(reading)}
    요건 확인 중(Verdict) ${stats(checking)}
  문서 사이 간격          ${stats(gaps)}
검토 시작 클릭~완료       ${((tDone - tPrepared) / 1000).toFixed(1)}s
상태                      ${run.run.status} ${JSON.stringify(run.counts)}
기대 판정과 일치          ${run.docs.length - mismatches.length}/${run.docs.length}`);
for (const m of mismatches) console.log(`  불일치 ${m.file}: 기대 ${m.expected}, 결과 ${byFile[m.file]} (개업 ${m.open}, ${m.addr}, 매출 ${m.revenue ?? "없음"}${m.unit ? " 천원표기" : ""})`);
console.log(`\n데이터: ${process.env.REVIEW_DATA_DIR}  서류: ${docsDir}  run: ${runId}`);
server.close(); await runner.stop();
process.exit(0);
