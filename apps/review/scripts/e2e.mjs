/**
 * 운영 화면 E2E: 실제 서버(실제 OCR·LLM·Verdict/Jev)에 대해 브라우저로 세 단계를 끝까지 조작한다.
 *   서버 실행 후: node apps/review/scripts/e2e.mjs http://localhost:8791
 *   배포된 서비스: REVIEW_ACCESS_CLIENT_ID / REVIEW_ACCESS_CLIENT_SECRET(Access 서비스 토큰)를 주고 공개 주소로 실행한다.
 * 스크린샷은 docs/verdict-review/screens/ 에 저장된다(배율 2).
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.argv[2] ?? "http://localhost:8791";
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const shots = fileURLToPath(new URL("../../../docs/verdict-review/screens/", import.meta.url));
mkdirSync(shots, { recursive: true });
const REQ = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";
const FILES = ["가온테크_신청서류.pdf", "바다물산_신청서류.pdf", "누리솔루션_사업자등록증.pdf", "한빛기계_스캔본.pdf", "다솜_경계값.pdf", "서울상사_지시문포함.pdf"].map((n) => fixtures + n);

// 이 환경의 Playwright는 한글 경로의 파일을 읽지 못해(빈 선택) 파일 내용을 버퍼로 넘긴다.
const payload = (path) => ({ name: basename(path), mimeType: "application/pdf", buffer: readFileSync(path) });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const accessHeaders = process.env.REVIEW_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": process.env.REVIEW_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.REVIEW_ACCESS_CLIENT_SECRET ?? "" } : undefined;
const contextOptions = (o) => ({ ...o, ...(accessHeaders ? { extraHTTPHeaders: accessHeaders } : {}) });
const browser = await chromium.launch();
const ctx = await browser.newContext(contextOptions({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// 1. 요건 단계: 제목·입력창·다음만
await page.goto(base);
const mainControls = async () => page.evaluate(() => [...document.querySelectorAll("main button, main textarea, main input:not([hidden]), main [role=button], main h1, main a, main select")].map((e) => `${e.tagName.toLowerCase()}:${(e.textContent || e.getAttribute("aria-label") || "").trim()}`));
check("요건 단계 요소는 제목·입력창·다음뿐", JSON.stringify(await mainControls()) === JSON.stringify(["h1:요건 입력", "textarea:", "button:다음"]), JSON.stringify(await mainControls()));
const next = page.getByRole("button", { name: "다음" });
check("빈 입력에서 다음 비활성", await next.isDisabled());
await page.locator("textarea").fill("   \n  ");
check("공백만 있으면 다음 비활성", await next.isDisabled());
await page.locator("textarea").fill(REQ);
check("입력 후 다음 활성", await next.isEnabled());
const banned = /기준일|창업일 기준|개업일|법인 설립일|증빙|해석된 조건|적용할 요건|예시/;
check("삭제된 설정·미리보기·예시 버튼 없음", !banned.test(await page.locator("main").innerText()));
await page.screenshot({ path: shots + "real-1-requirement.png" });
await next.click();

// 2. 서류 단계: 드롭 영역 클릭으로 파일 선택(별도 선택 버튼 없음)
const uploadControls = await mainControls();
check("서류 단계 요소는 드롭 영역·이전·검토 시작뿐", JSON.stringify(uploadControls) === JSON.stringify(["div:파일을 끌어놓거나 클릭하세요", "button:이전", "button:검토 시작"]), JSON.stringify(uploadControls));
check("파일 없으면 검토 시작 비활성", await page.getByRole("button", { name: "검토 시작" }).isDisabled());
let chooser = page.waitForEvent("filechooser");
await page.locator("[data-dropzone]").click();
await (await chooser).setFiles([...FILES, fixtures + "손상된_파일.pdf"].map(payload));
await page.waitForTimeout(600);
await page.screenshot({ path: shots + "real-2-upload-progress.png" });
await page.waitForFunction(() => document.querySelectorAll("[data-file-row=preparing], [data-file-row=uploading]").length === 0, null, { timeout: 180_000 });
check("손상 파일은 행 안에서 오류 + 재시도", (await page.locator("[data-file-row=error]").innerText()).includes("PDF를 열 수 없습니다"));
check("오류 파일이 있으면 검토 시작 비활성(몰래 제외 안 함)", await page.getByRole("button", { name: "검토 시작" }).isDisabled());
await page.screenshot({ path: shots + "real-3-upload-error.png" });
await page.getByRole("button", { name: "손상된_파일.pdf 삭제" }).click();
check("정상 파일 행에 상태 배지 없음", (await page.locator("ul[aria-label='업로드된 서류']").innerText()).split("\n").every((l) => l.endsWith(".pdf")));
// 키보드로 드롭 영역 활성화
await page.locator("[data-dropzone]").focus();
chooser = page.waitForEvent("filechooser", { timeout: 3000 }).then(() => true, () => false);
await page.keyboard.press("Enter");
check("키보드(Enter)로 파일 선택창", await chooser);
// 이전 → 다시 진행해도 입력·파일 유지
await page.getByRole("button", { name: "이전" }).click();
check("이전으로 돌아가도 요건 유지", (await page.locator("textarea").inputValue()) === REQ);
await page.getByRole("button", { name: "다음" }).click();
check("다시 진행해도 파일 목록 유지", (await page.locator("[data-file-row]").count()) === FILES.length);

// 3. 검토: 모션 기록
const watchFlights = () => page.evaluate(() => {
  window.__flights = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.dataset.flight !== undefined) window.__flights.push({ at: performance.now(), label: n.textContent }); }).observe(document.body, { childList: true });
});
await watchFlights();
let flightsBefore = 0;
await page.getByRole("button", { name: "검토 시작" }).click();
await page.waitForURL(/run=/);
const runId = new URL(page.url()).searchParams.get("run");
await page.waitForSelector("[data-current]", { timeout: 120_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: shots + "real-4-reviewing.png" });
await page.waitForFunction(() => document.querySelector("[data-bin=met] [data-doc-row]") || document.querySelector("[data-bin=not_met] [data-doc-row]"), null, { timeout: 120_000 });

// 상세를 연 채로 검토 진행: 선택 문서·포커스 유지
const firstRow = page.locator("[data-doc-row]").first();
const opened = (await firstRow.innerText()).trim();
await firstRow.click();
await page.waitForSelector("[data-detail] article", { timeout: 30_000 });
await page.waitForTimeout(700);
const box = await page.locator("[data-detail]").boundingBox();
check("상세 Sheet가 화면 안에 열림", !!box && box.x >= 0 && box.x + box.width <= 1440 + 1, JSON.stringify(box));
await page.screenshot({ path: shots + "real-5-detail-while-running.png" });
const before = await page.evaluate(() => ({ seq: document.querySelectorAll("[data-doc-row]").length }));
await page.waitForFunction((n) => document.querySelectorAll("[data-doc-row]").length > n, before.seq, { timeout: 120_000 });
const title = await page.locator("[data-detail] h2").first().innerText();
const focusInSheet = await page.evaluate(() => !!document.activeElement?.closest("[data-detail]"));
check("상세를 보는 동안 다음 문서가 완료돼도 선택 유지", title.trim() === opened, `${title} / ${opened}`);
check("상세를 보는 동안 포커스 유지", focusInSheet);
await page.keyboard.press("Escape");

// 일시정지 → 저장 후 멈춤 → 재개
await page.getByRole("button", { name: "일시정지" }).click().catch(() => {});
await page.waitForFunction(() => /일시정지됨/.test(document.body.innerText) || /검토 완료/.test(document.body.innerText), null, { timeout: 120_000 });
const paused = await page.evaluate(() => /일시정지됨/.test(document.body.innerText));
const snapPaused = await (await page.request.get(`${base}/api/runs/${runId}`)).json();
check("일시정지: 진행 중 문서 없이 멈춤", !paused || snapPaused.counts.reviewing === 0, JSON.stringify(snapPaused.counts));
if (paused) {
  await page.waitForTimeout(1500);
  const still = await (await page.request.get(`${base}/api/runs/${runId}`)).json();
  check("일시정지 중 다음 문서를 시작하지 않음", still.counts.reviewing === 0 && still.counts.queued === snapPaused.counts.queued);
  // 새로고침해도 상태 복구
  flightsBefore = await page.evaluate(() => window.__flights.length);
  await page.reload();
  await watchFlights();
  await page.waitForSelector("[data-bin]");
  await page.waitForTimeout(1000);
  check("복구 시 완료 문서를 다시 이동시키지 않음", (await page.evaluate(() => window.__flights.length)) === 0);
  const shown = await page.locator("[data-bin=met]").getAttribute("aria-label");
  check("새로고침 후 같은 결과 복구", shown === `충족 ${snapPaused.counts.met}건`, `${shown}`);
  await page.getByRole("button", { name: "재개" }).click();
}
await page.waitForFunction(() => /검토 완료/.test(document.body.innerText), null, { timeout: 300_000 });
await page.waitForTimeout(900);
await page.screenshot({ path: shots + "real-6-completed.png" });
const snap = await (await page.request.get(`${base}/api/runs/${runId}`)).json();
const ui = {};
for (const o of ["met", "not_met", "needs_review"]) ui[o] = Number((await page.locator(`[data-bin=${o}]`).getAttribute("aria-label")).match(/(\d+)건/)[1]);
check("화면 건수 = 서버 저장 상태", ui.met === snap.counts.met && ui.not_met === snap.counts.not_met && ui.needs_review === snap.counts.needs_review, JSON.stringify({ ui, server: snap.counts }));
const flights = flightsBefore + (await page.evaluate(() => window.__flights.length));
check("문서 이동 모션이 실제 이벤트에 맞춰 생성됨", flights >= FILES.length, `${flights}개`);
const expected = { "가온테크_신청서류.pdf": "met", "바다물산_신청서류.pdf": "not_met", "누리솔루션_사업자등록증.pdf": "needs_review", "한빛기계_스캔본.pdf": "met", "다솜_경계값.pdf": "met", "서울상사_지시문포함.pdf": "not_met" };
const got = Object.fromEntries(snap.docs.map((d) => [d.fileName, d.status]));
check("실제 판정 결과(6건)", JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.keys(got).map((k) => [k, expected[k]]))), JSON.stringify(got));
// 상세: 근거(인용·쪽) 연결
await page.locator("[data-bin=met] [data-doc-row]").first().click();
await page.waitForSelector("[data-detail] article q");
await page.waitForTimeout(700);
const detailText = await page.locator("[data-detail]").innerText();
check("상세에 인용과 쪽수", /쪽/.test(detailText) && /“|"/.test(detailText) || (await page.locator("[data-detail] q").count()) > 0);
await page.screenshot({ path: shots + "real-7-detail.png" });
await page.keyboard.press("Escape");

// 모바일 배치(같은 실행)
const mobile = await browser.newContext(contextOptions({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }));
const mp = await mobile.newPage();
await mp.goto(`${base}/?run=${runId}`);
await mp.waitForSelector("[data-bin]");
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("모바일 가로 넘침 없음", overflow === 0, `${overflow}px`);
const order = await mp.evaluate(() => ["pile", "center", "bins"].map((a) => document.querySelector(`[data-area=${a}]`).getBoundingClientRect().top));
check("모바일: 대기 → 현재 → 결과 세로 배치", order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
await mp.screenshot({ path: shots + "real-8-mobile-completed.png", fullPage: true });

// 동작 줄이기: 새 실행에서 이동 모션 없이 같은 결과
const reduced = await browser.newContext(contextOptions({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }));
const rp = await reduced.newPage();
await rp.goto(base);
await rp.evaluate(() => localStorage.clear());
await rp.goto(base);
await rp.locator("textarea").fill("울산 소재 기업");
await rp.getByRole("button", { name: "다음" }).click();
chooser = rp.waitForEvent("filechooser");
await rp.locator("[data-dropzone]").click();
await (await chooser).setFiles([FILES[0], FILES[1]].map(payload));
await rp.waitForFunction(() => document.querySelectorAll("[data-file-row=ready]").length === 2, null, { timeout: 120_000 });
await rp.evaluate(() => { window.__flights = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.dataset.flight !== undefined) window.__flights++; }).observe(document.body, { childList: true }); });
await rp.getByRole("button", { name: "검토 시작" }).click();
await rp.waitForFunction(() => /검토 완료/.test(document.body.innerText), null, { timeout: 180_000 });
const rFlights = await rp.evaluate(() => window.__flights);
const rCounts = { met: await rp.locator("[data-bin=met]").getAttribute("aria-label"), not_met: await rp.locator("[data-bin=not_met]").getAttribute("aria-label") };
check("동작 줄이기: 이동 모션 없음, 결과 동일하게 표시", rFlights === 0 && rCounts.met === "충족 1건" && rCounts.not_met === "미충족 1건", JSON.stringify({ rFlights, rCounts }));

check("페이지 오류 없음", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
