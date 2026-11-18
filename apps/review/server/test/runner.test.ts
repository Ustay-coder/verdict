/**
 * 실행기·HTTP 상태 검증(모형 LLM + 모형 Jev, 오프라인). 100건 수준의 상태·복구·중복 방지를 확인한다.
 * 여기서의 속도는 모형 기준이며 실제 처리 성능이 아니다.
 */
import { envAuth } from "@verdict-ai/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewApp } from "../src/app.js";
import { Repo } from "../src/db.js";
import { FilePreparer, FileStorage } from "../src/files.js";
import type { LlmCall } from "../src/llm.js";
import { Runner } from "../src/runner.js";
import { fakeLlm, makeEngine, rawReq, SETTINGS } from "./helpers.js";

const REQUIREMENT = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";

/** 모형 사실 추출: 문서 텍스트에서 정해진 줄을 그대로 인용한다(실제 모델 아님). */
function factsFromDoc(call: LlmCall) {
  const text = String(call.user);
  if (text.includes("BROKEN")) throw new Error("HTTP 500 from fake model");
  const facts = [];
  const open = /개업연월일 : (\d{4}-\d{2}-\d{2})/.exec(text);
  if (open) facts.push({ requirementId: "r1", label: "개업연월일", valueType: "date", value: open[1], unitQuote: null, quote: open[0], page: 1 });
  const city = /사업장 소재지 : (\S+)/.exec(text);
  if (city) facts.push({ requirementId: "r2", label: "사업장 소재지", valueType: "text", value: city[1], unitQuote: null, quote: city[0], page: 1 });
  const rev = /매출액 ([\d,]+)원/.exec(text);
  if (rev) facts.push({ requirementId: "r3", label: "2025년 매출액", valueType: "number", value: rev[1]!.replace(/,/g, ""), unitQuote: null, quote: rev[0], page: 1 });
  return { facts, missing: [] };
}

function compileAnswer() {
  return {
    requirements: [
      rawReq({ id: "a", text: "창업 3년 이상", kind: "elapsed", subject: "창업일", comparator: ">=", years: 3, referenceDate: "2025-12-31" }),
      rawReq({ id: "b", text: "울산 소재 기업", kind: "text", subject: "사업장 소재지" }),
      rawReq({ id: "c", text: "2025년 매출 1억 원 이상", kind: "number", subject: "2025년 매출액", comparator: ">=", threshold: 100_000_000, unit: "원" }),
    ],
    logic: "a AND b AND c",
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "review-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setup(opts: { hook?: (call: LlmCall) => void; env?: Record<string, string> } = {}) {
  const repo = new Repo(join(dir, "review.sqlite"));
  const llm = fakeLlm({ requirements: () => compileAnswer(), facts: (call) => { opts.hook?.(call); return factsFromDoc(call); } });
  const { engine, router } = makeEngine((state) => (state.includes("울산") ? "met" : "not_met"));
  const runner = new Runner({ repo, engine, llm, settings: SETTINGS }, router);
  const preparer = new FilePreparer(repo, new FileStorage(dir), { llm, ocrModel: "fake" });
  const app = createReviewApp({ repo, runner, preparer, auth: envAuth(opts.env ?? {}), settings: SETTINGS, heartbeatMs: 50 });
  return { repo, runner, preparer, app, llm };
}

function docText(i: number) {
  const kind = i % 3;
  return kind === 0 ? `사업자등록증\n개업연월일 : 2019-03-02\n사업장 소재지 : 울산광역시\n매출액 120,000,000원`
    : kind === 1 ? `개업연월일 : 2024-01-05\n사업장 소재지 : 부산광역시\n매출액 30,000,000원`
      : `개업연월일 : 2018-07-01\n사업장 소재지 : 울산광역시`;
}

async function upload(app: ReturnType<typeof setup>["app"], name: string, text: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([text], name, { type: "text/plain" }));
  const res = await app.request("/api/files", { method: "POST", body: form, headers });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; status: string };
}

async function startRun(app: ReturnType<typeof setup>["app"], fileIds: string[], headers: Record<string, string> = {}) {
  const res = await app.request("/api/runs", { method: "POST", body: JSON.stringify({ requirement: REQUIREMENT, fileIds }), headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: (await res.json()) as { run: { id: string; status: string; lastSeq: number }; counts: Record<string, number>; docs: Array<{ docId: string; status: string; fileName: string }> } };
}

describe("runner and HTTP contract (mock engine)", () => {
  it("reviews 100 documents in order, isolates a failing one, and counts each exactly once", async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push((await upload(s.app, `doc-${String(i).padStart(3, "0")}.txt`, i === 41 ? "BROKEN" : docText(i))).id);
    await s.preparer.whenIdle();
    const { status, body } = await startRun(s.app, ids);
    expect(status).toBe(201);
    expect(body.docs.map((d) => d.fileName)).toEqual(ids.map((_, i) => `doc-${String(i).padStart(3, "0")}.txt`));
    await s.runner.drain();
    const snap = s.repo.getRun(body.run.id)!;
    expect(snap.status).toBe("completed");
    const counts = s.repo.counts(body.run.id);
    expect(counts).toMatchObject({ queued: 0, reviewing: 0, error: 1 });
    expect(counts.met + counts.not_met + counts.needs_review).toBe(99);
    // 0: 충족, 1: 부산·업력 부족·매출 부족 → 미충족, 2: 매출 없음 → 확인 필요
    expect(counts.met).toBe(34);
    expect(counts.not_met).toBe(33);
    expect(counts.needs_review).toBe(32);
    const events = s.repo.listEvents(body.run.id, 0, 100_000);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === "doc.completed")).toHaveLength(99);
    const started = events.filter((e) => e.type === "doc.started").map((e) => e.payload.docId);
    expect(started).toEqual(body.docs.map((d) => d.docId));
    // 요건별 결과는 Verdict criterion.scored 이벤트에서 온다.
    expect(events.filter((e) => e.type === "doc.requirement" && e.payload.docId === "d0001").map((e) => e.payload.requirementId).sort()).toEqual(["r1", "r2", "r3"]);

    // 재시도: 오류 문서만 다시, 다른 결과 보존, 중복 집계 없음.
    s.repo.db.prepare("UPDATE files SET extraction_json = ? WHERE id = ?").run(JSON.stringify({ kind: "text", pages: [{ page: 1, text: docText(0), source: "text" }], warnings: [], chars: 10 }), ids[41]);
    const retry = await s.app.request(`/api/runs/${body.run.id}/docs/d0042/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect((await s.app.request(`/api/runs/${body.run.id}/docs/d0042/retry`, { method: "POST" })).status).toBe(409);
    expect((await s.app.request(`/api/runs/${body.run.id}/docs/d0001/retry`, { method: "POST" })).status).toBe(409);
    await s.runner.drain();
    const after = s.repo.counts(body.run.id);
    expect(after).toMatchObject({ error: 0, met: 35, not_met: 33, needs_review: 32 });
    expect(s.repo.getDoc(body.run.id, "d0042")!.attempt).toBe(2);
    expect(s.repo.getRun(body.run.id)!.status).toBe("completed");
    s.repo.close();
  });

  it("pauses after saving the current document and resumes from the next one", async () => {
    let s!: ReturnType<typeof setup>;
    let runId = "";
    let seen = 0;
    s = setup({ hook: () => { seen++; if (seen === 3) s.runner.pause(s.repo.getRun(runId)!); } });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await upload(s.app, `p${i}.txt`, docText(i))).id);
    await s.preparer.whenIdle();
    runId = (await startRun(s.app, ids)).body.run.id;
    await s.runner.drain();
    const docs = s.repo.listDocs(runId);
    expect(s.repo.getRun(runId)!.status).toBe("paused");
    expect(docs.slice(0, 3).every((d) => ["met", "not_met", "needs_review"].includes(d.status))).toBe(true);
    expect(docs.slice(3).every((d) => d.status === "queued")).toBe(true);
    const resumed = await s.app.request(`/api/runs/${runId}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    await s.runner.drain();
    expect(s.repo.getRun(runId)!.status).toBe("completed");
    const statuses = s.repo.listEvents(runId, 0).filter((e) => e.type === "run.status").map((e) => e.payload.status);
    expect(statuses).toEqual(["preparing", "running", "pausing", "paused", "running", "completed"]);
    s.repo.close();
  });

  it("recovers after a restart without redoing finished documents", async () => {
    const s = setup();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await upload(s.app, `r${i}.txt`, docText(0))).id);
    await s.preparer.whenIdle();
    const runId = (await startRun(s.app, ids)).body.run.id;
    for (let i = 0; i < 3; i++) await s.runner.step(); // compile + 2 docs
    // 서버가 문서 3을 검토하던 중 멈춘 상태를 만든다.
    s.repo.transitionDoc(runId, "d0003", ["queued"], "reviewing", { stage: "checking" }, { type: "doc.started", payload: {} });
    const before = s.repo.listDocs(runId).filter((d) => d.status === "met").map((d) => d.completedAt);
    s.repo.close();

    const s2 = setup();
    s2.runner.recover();
    expect(s2.repo.getDoc(runId, "d0003")!.status).toBe("queued");
    expect(s2.repo.listEvents(runId, 0).at(-1)).toMatchObject({ type: "doc.requeued", payload: { docId: "d0003", reason: "restart" } });
    await s2.runner.drain();
    const docs = s2.repo.listDocs(runId);
    expect(docs.filter((d) => d.status === "met").slice(0, 2).map((d) => d.completedAt)).toEqual(before);
    expect(s2.repo.counts(runId).met).toBe(5);
    expect(s2.repo.listEvents(runId, 0).filter((e) => e.type === "doc.completed")).toHaveLength(5);
    s2.repo.close();
  });

  it("replays events after a given seq over SSE and snapshots agree with events", async () => {
    const s = setup();
    const ids = [(await upload(s.app, "a.txt", docText(0))).id, (await upload(s.app, "b.txt", docText(1))).id];
    await s.preparer.whenIdle();
    const runId = (await startRun(s.app, ids)).body.run.id;
    await s.runner.drain();
    const snap = (await (await s.app.request(`/api/runs/${runId}`)).json()) as { run: { lastSeq: number }; counts: Record<string, number> };
    const ac = new AbortController();
    const res = await s.app.request(`/api/runs/${runId}/events`, { headers: { "last-event-id": "3" }, signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes(`id: ${snap.run.lastSeq}\n`)) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    await reader.cancel().catch(() => {});
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(seqs[0]).toBe(4);
    expect(seqs).toEqual(Array.from({ length: snap.run.lastSeq - 3 }, (_, i) => i + 4));
    expect(snap.counts.met + snap.counts.not_met).toBe(2);
    const detail = (await (await s.app.request(`/api/runs/${runId}/docs/d0001`)).json()) as { result: { verdict: string; requirements: Array<{ facts: Array<{ page: number; quote: string }> }> } };
    expect(detail.result.verdict).toBe("met");
    expect(detail.result.requirements[0]!.facts[0]).toMatchObject({ page: 1, quote: "개업연월일 : 2019-03-02" });
    s.repo.close();
  });

  it("scopes files and runs by tenant, refuses unready files and replays idempotent starts", async () => {
    const s = setup({ env: { VERDICT_API_KEYS: "k1:t1,k2:t2" } });
    const h1 = { authorization: "Bearer k1" };
    const h2 = { authorization: "Bearer k2" };
    expect((await s.app.request("/api/files?ids=x")).status).toBe(401);
    const f = await upload(s.app, "a.txt", docText(0), h1);
    expect((await startRun(s.app, [f.id], h1)).status).toBe(409); // 아직 준비 중
    await s.preparer.whenIdle();
    expect((await startRun(s.app, [f.id], h2)).status).toBe(404); // 다른 tenant의 파일
    const key = { ...h1, "idempotency-key": "click-1" };
    const first = await startRun(s.app, [f.id], key);
    const again = await startRun(s.app, [f.id], key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.run.id).toBe(first.body.run.id);
    expect((await s.app.request(`/api/runs/${first.body.run.id}`, { headers: h2 })).status).toBe(404);
    expect((await s.app.request(`/api/runs/${first.body.run.id}`, { headers: h1 })).status).toBe(200);
    // 실행이 참조하는 파일 삭제는 목록에서만 숨기고 결과는 남긴다.
    expect((await s.app.request(`/api/files/${f.id}`, { method: "DELETE", headers: h1 })).status).toBe(204);
    expect(s.repo.getFile(f.id, "t1")!.deletedAt).not.toBeNull();
    s.repo.close();
  });

  it("marks unsupported or empty files as errors in their row and lets a failed compile be retried", async () => {
    const s = setup();
    const form = new FormData();
    form.set("file", new File([new Uint8Array([80, 75, 3, 4, 0, 0])], "a.hwpx"));
    const bad = (await (await s.app.request("/api/files", { method: "POST", body: form })).json()) as { id: string };
    await s.preparer.whenIdle();
    const row = ((await (await s.app.request(`/api/files?ids=${bad.id}`)).json()) as { data: Array<{ status: string; error: string }> }).data[0]!;
    expect(row).toMatchObject({ status: "error", error: "지원하지 않는 형식입니다 (PDF·이미지·텍스트)" });

    const good = await upload(s.app, "g.txt", docText(0));
    await s.preparer.whenIdle();
    const broken = new Runner({ repo: s.repo, engine: makeEngine().engine, llm: fakeLlm({ requirements: () => { throw new Error("HTTP 503"); } }), settings: SETTINGS });
    const runId = (await startRun(s.app, [good.id])).body.run.id;
    await broken.drain();
    expect(s.repo.getRun(runId)).toMatchObject({ status: "failed" });
    expect(s.repo.getRun(runId)!.error).toMatch(/요건 해석 실패/);
    expect((await s.app.request(`/api/runs/${runId}/retry`, { method: "POST" })).status).toBe(200);
    await s.runner.drain();
    expect(s.repo.getRun(runId)!.status).toBe("completed");
    s.repo.close();
  });
});
