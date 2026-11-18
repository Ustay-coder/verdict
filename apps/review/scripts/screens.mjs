/**
 * UI 시안 스크린샷(개발용 모형 데이터). 서버를 REVIEW_SERVE_PROTOTYPE=1로 띄운 뒤:
 *   node apps/review/scripts/screens.mjs http://localhost:8791
 * 결과: docs/verdict-review/screens/proto-<상태>-<desktop|mobile>.png (배율 2)
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.argv[2] ?? "http://localhost:8791";
const out = fileURLToPath(new URL("../../../docs/verdict-review/screens/", import.meta.url));
mkdirSync(out, { recursive: true });
const STATES = [["req-empty", 600], ["req-filled", 600], ["upload-empty", 600], ["upload-files", 900], ["upload-progress", 1500], ["review", 1450], ["review", 4300, "review-sequential"], ["detail", 1300], ["done", 900]];
const browser = await chromium.launch();
for (const [kind, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 2 })).newPage();
  for (const [id, wait, name] of STATES) {
    await page.goto(`${base}/prototype.html?s=${id}`);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${out}proto-${name ?? id}-${kind}.png`, fullPage: kind === "mobile" });
  }
}
await browser.close();
console.log("screens written to", out);
