/**
 * 실제 연동 검증: 예시 PDF를 실제 서버 API로 업로드 → 실제 OCR/LLM 사실 추출 → 실제 Verdict(Jev) 판정 → 결과 저장.
 *   NODE_USE_ENV_PROXY=1 node apps/review/scripts/live-check.mjs "<요건>"
 * 필요: OPENAI_API_KEY(또는 프록시 주입), TYPESAFE_API_KEY. 데이터는 임시 디렉터리에 저장된다.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
process.env.REVIEW_DATA_DIR ??= mkdtempSync(join(tmpdir(), "review-live-"));
process.env.PORT ??= "8799";
process.env.OPENAI_API_KEY ??= "sk-proxy-injected";
const { startReviewServer } = await import("../server/dist/main.js");
const { server, runner } = await startReviewServer();
const base = `http://localhost:${process.env.PORT}`;
const requirement = process.argv[2] ?? "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";
const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const names = (process.argv[3]?.split(",") ?? readdirSync(dir).filter((n) => n.endsWith(".pdf"))).sort();
const ids = [];
for (const name of names) {
  const form = new FormData();
  form.set("file", new File([readFileSync(join(dir, name))], name, { type: "application/pdf" }));
  ids.push((await (await fetch(`${base}/api/files`, { method: "POST", body: form })).json()).id);
}
let files;
for (;;) {
  files = (await (await fetch(`${base}/api/files?ids=${ids.join(",")}`)).json()).data;
  if (files.every((f) => f.status !== "preparing")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
for (const f of files) console.log(`[file] ${f.name}: ${f.status}${f.error ? ` — ${f.error}` : ""}`);
const ready = files.filter((f) => f.status === "ready").map((f) => f.id);
const started = Date.now();
const snap = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requirement, fileIds: ready }) })).json();
const runId = snap.run.id;
let run;
for (;;) {
  run = await (await fetch(`${base}/api/runs/${runId}`)).json();
  if (["completed", "failed", "paused"].includes(run.run.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`\n[run] ${run.run.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`, run.run.error ?? "", run.counts);
console.log("[requirements]", JSON.stringify(run.run.requirements));
for (const d of run.docs) {
  const detail = await (await fetch(`${base}/api/runs/${runId}/docs/${d.docId}`)).json();
  console.log(`\n== ${d.fileName}: ${d.status}${d.error ? ` — ${d.error}` : ""}`);
  for (const r of detail.result?.requirements ?? []) {
    console.log(`  - [${r.outcome}] ${r.text}: ${r.reason}`);
    for (const f of r.facts) console.log(`      fact ${f.label}=${f.value} p.${f.page}${f.source === "ocr" ? " (OCR)" : ""} "${f.quote}"`);
    for (const f of r.rejected) console.log(`      rejected ${f.label}=${f.value}: ${f.reason}`);
    if (r.needed.length) console.log(`      needed: ${r.needed.join(" | ")}`);
  }
  if (detail.result) console.log(`  models: ${JSON.stringify(detail.result.models)} evaluation=${detail.result.evaluationId}`);
}
server.close(); await runner.stop();
console.log(`\ndata dir: ${process.env.REVIEW_DATA_DIR}`);
process.exit(0);
