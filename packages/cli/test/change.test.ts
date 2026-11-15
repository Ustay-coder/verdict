import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { request } from "node:http";
import { resolve } from "node:path";
import { Engine, MemoryStore, seedChangeDemo } from "@verdict-ai/core";
import { registerChangeTest } from "../src/commands/change-test.js";
import { createWatchServer } from "../src/commands/watch.js";
import { draftOf, expectationRow, indexScreen, newTestScreen, sideBySide, testScreen } from "../src/watch/change-client.js";
import { caseTable, deltaChart, sortRows, summaryTiles, trialScreen, type ResultUi } from "../src/watch/change-results.js";
import { changeIndex, judgeConnection, testView, trialView } from "../src/watch/change-state.js";
import { changePage } from "../src/watch/page.js";
import type { VersionDependencies } from "../src/versions/workspace.js";

const env = () => undefined;
const ui = (over: Partial<ResultUi> = {}): ResultUi => ({ target: "customer_validation", sort: "order", filter: "", ...over });

async function demo() {
  const store = new MemoryStore();
  const engine = new Engine({ store });
  const { tests } = await seedChangeDemo(engine, store);
  return { store, engine, intended: tests[0]!, wrong: tests[1]! };
}

describe("change-test views", () => {
  it("lists tests with the rate next to its denominator, and offers writes only when the page may write", async () => {
    const t = await demo();
    const view = await changeIndex(t.store, { writable: true, env });
    expect(view.tests.map((x) => [x.name.slice(0, 6), x.cases, x.latest?.status])).toEqual([["Demo 2", 7, "partial"], ["Demo 1", 3, "completed"]]);
    const page = indexScreen(view);
    expect(page).toContain("2 of 4 verifiable cases met · 7 in all, left out: 2 not comparable, 1 without expectations");
    expect(page).toContain("3 of 3 verifiable cases met · 3 in all");
    expect(page).toContain("Demo data");
    expect(page).toContain('data-act="demo"');
    const readOnly = indexScreen({ ...view, writable: false, notice: "bound to 0.0.0.0, which other machines can reach" });
    expect(readOnly).toContain("Read-only: bound to 0.0.0.0");
    expect(readOnly).not.toContain("data-act");
    expect(indexScreen({ tests: [], versions: [], datasets: [], writable: true })).toContain("No change tests yet.");
    expect(newTestScreen({ tests: [], versions: [], datasets: [], writable: true }, {})).toContain("Still needed: a frozen rubric version and a document set");
  });

  it("shows the setup of a test: what changed, the saved expectations, the connection of each judge and how many evaluations a trial costs", async () => {
    const t = await demo();
    const view = await testView(t.store, t.intended.test.id, { writable: true, env });
    expect(view.changes.map((c) => c.kind)).toEqual(["wording", "options", "scoring", "open_options"]);
    expect(view.estimate).toEqual({ documents: 3, evaluations: 3, reused: 3 });
    expect(view.baseline.judges).toEqual([{ where: "defaultJudge", type: "llm", provider: "mock", state: "mock", note: "scripted mock: answers are written into the rubric, not judged by a model" }]);
    const draft = draftOf(view);
    expect(draft.B).toEqual([{ type: "decrease", criterion: "customer_validation", by: 4 }, { type: "range", criterion: "customer_validation", min: 6, max: 6 }]);
    const page = testScreen(view, draft, { dirty: false, again: false });
    expect(page).toContain("3 documents × 2 versions × 1 run = 6 evaluations; 3 stored results are shown again, so <b>3 new</b>");
    expect(page).toContain("No cost estimate");
    expect(page).toContain("Stated intent — written by the author; no judge and no check reads it");
    expect(page).toContain("It does not show that a result holds when the document is reworded or reordered.");
    expect(page).toContain("Defaults: no tolerance; a rise or drop means any amount above 0");
    expect(page).toMatch(/data-act="save-exp" disabled/);
    expect(testScreen(view, draft, { dirty: true, again: true })).toContain("3 documents × 2 versions × 1 run = 6 evaluations, <b>6 new</b>");
    expect(testScreen(view, draft, { dirty: true, again: false })).toMatch(/data-act="run" disabled/);
    expect(testScreen({ ...view, writable: false }, draft, { dirty: false, again: false })).not.toContain('data-act="run"');
  });

  it("says whether a judge can be reached from its keys alone", () => {
    const set = (name: string) => (name === "TYPESAFE_API_KEY" || name === "GOOGLE_API_KEY" ? "x" : undefined);
    const state = (spec: Record<string, unknown>) => judgeConnection("j", spec as never, set).map((c) => [c.state, c.note]);
    expect(state({ type: "decision", provider: "typesafe" })).toEqual([["ready", "TYPESAFE_API_KEY is set (not checked against the provider)"]]);
    expect(state({ type: "decision", provider: "gemini" })[0]![0]).toBe("ready");
    expect(state({ type: "llm", provider: "anthropic" })).toEqual([["missing", "ANTHROPIC_API_KEY is not set where verdict watch runs"]]);
    expect(state({ type: "llm", provider: "openai", apiKeyEnv: "MY_KEY" })).toEqual([["missing", "MY_KEY is not set where verdict watch runs"]]);
    expect(state({ type: "decision", provider: "mock" })).toEqual([["mock", "mock: a deterministic stand-in, not a model"]]);
    expect(state({ type: "human" })).toEqual([["none", "a person answers"]]);
    expect(state({ type: "panel", judges: [{ type: "decision", provider: "mock" }, { type: "benchmark", method: "regex", pattern: "x" }] }).map((x) => x[0])).toEqual(["mock", "none"]);
  });

  it("draws an open score as open: not in the chart at zero, not as a number in the table", async () => {
    const t = await demo();
    const view = await trialView(t.store, t.intended.trial.id, { writable: true, env });
    expect(view.cases.map((c) => [c.caseId, c.changes.customer_validation!.delta, c.changes.total!.delta])).toEqual([["A", 0, 0], ["B", -4, -4], ["C", null, null]]);
    expect(view.cases[2]!.changes.customer_validation).toEqual({ base: 10, head: null, baseRange: [0, 10], headRange: [0, 10], delta: null, reason: "no score: it asks for more information" });
    const chart = deltaChart(view, ui());
    expect(chart.match(/class="cbar"/g)).toHaveLength(2);
    expect(chart).toContain('aria-label="B · 무료 실증 고객 3곳: drop of 4, met"');
    expect(chart).toContain('class="fill down" style="right:50%;width:50%"');
    expect(chart).toContain("No difference to plot (1) — not drawn at zero");
    expect(chart).toMatch(/class="cbar flat" data-case="C"[^>]*>.*no score: it asks for more information/);
    expect(chart).toContain("A drop or a rise is neither good nor bad by itself.");
    const table = caseTable(view, ui());
    const rowC = table.slice(table.indexOf('<tr class="" data-case="C"'));
    expect(rowC).toContain('<span class="nos">needs information</span> <span class="muted">— / 10</span>');
    expect(rowC).toContain('<span class="nos">—</span><small class="muted">candidate score open</small>');
    expect(rowC).toContain("scored → <b>needs information</b>");
    expect(rowC).toContain("✓ Met");
    expect(rowC).not.toMatch(/class="dl"/);
    expect(table).toContain('<b class="dl">−4</b>');
  });

  it("links the chart, the table and the detail to one selection, with the reasons and the evidence", async () => {
    const t = await demo();
    const view = await trialView(t.store, t.intended.trial.id, { writable: true, env });
    const page = trialScreen(view, ui({ selected: "B" }));
    expect(page).toContain('class="cbar sel" data-case="B" aria-pressed="true"');
    expect(page).toContain('<tr class="sel" data-case="B">');
    expect(page).toContain('aria-label="Detail of B · 무료 실증 고객 3곳"');
    expect(page).toContain("customer_validation went 10 → 6 (-4); expected a drop of at least 4");
    expect(page).toContain("✓ Same conditions.");
    expect(page).toContain("Scripted mock judge");
    expect(page).toMatch(/<button class="quote" data-mark="m-0-\d+-\d+">“3곳 모두 무료 실증\(PoC\) 고객이며, 유료 계약 고객은 0곳입니다.”<\/button> <span class="muted">신청서 B, line 3<\/span>/);
    expect(page).toMatch(/<mark id="m-0-\d+-\d+" tabindex="-1">3곳 모두 무료 실증\(PoC\) 고객이며, 유료 계약 고객은 0곳입니다.<\/mark>/);
    expect(page).toContain("judge&#39;s reason — said by the judge, not checked".replace("&#39;", "'"));
    expect(page).toContain("<code>customers_3_paid_under_3</code> — 전체 고객은 3곳 이상이고");
    expect(page).toContain("(worth 6 by the rubric)");
    const open = trialScreen(view, ui({ selected: "C" }));
    expect(open).toContain("<code>customer_payment_status</code> — “확보한 고객 중 유료 계약 고객은 몇 곳이며, 무료 실증 고객은 몇 곳인가요?”");
    expect(open).toContain('<span class="nos">open</span> <span class="muted">customer_validation not scored');
    expect(trialScreen(view, ui())).toContain("Select a document in the chart or the table");
  });

  it("shows mismatches, failures, invalid output and missing expectations as what they are, with three separate tallies", async () => {
    const t = await demo();
    const view = await trialView(t.store, t.wrong.trial.id, { writable: true, env });
    const tiles = summaryTiles(view);
    expect(tiles).toContain("<b>2 of 4</b> verifiable cases met");
    expect(tiles).toContain("7 cases in all; left out of the rate: 2 not comparable, 1 without expectations.");
    expect(tiles).toContain("<b>5</b> of 7 cases evaluated on both sides");
    expect(tiles).toContain("<b>2</b> failed or stored invalid output");
    expect(tiles).toContain("They are not meant to add up to each other.");
    expect(sortRows(view, ui({ sort: "status" })).map((r) => r.caseId)).toEqual(["B", "C", "E", "G", "D", "A", "F"]);
    expect(sortRows(view, ui({ sort: "drop" })).map((r) => r.caseId)).toEqual(["C", "A", "B", "D", "F", "E", "G"]);
    expect(sortRows(view, ui({ filter: "unmet" })).map((r) => r.caseId)).toEqual(["B", "C"]);
    expect(trialScreen(view, ui({ filter: "unmet" }))).toContain("Showing 2 of 7 cases");
    const table = caseTable(view, ui());
    expect(table).toContain('<span class="nos ex-invalid_output">invalid output</span>');
    expect(table).toContain('<span class="nos ex-failed">failed</span>');
    expect(table).toContain("○ Not verified");
    expect(table).toContain('<span class="muted">none written</span>');
    const g = trialScreen(view, ui({ selected: "G" }));
    expect(g).toContain("The stored output failed validation. Nothing of it is read as a score.");
    expect(g).toContain("<code>open_with_final_total</code> customer_validation is still open, yet a final total of 0 is stored");
    const f = trialScreen(view, ui({ selected: "F" }));
    expect(f).toContain("“유료 고객 10곳과 3년 계약을 체결했습니다.” <span class=\"chip warn\">✗ not found in the document — not linked</span>");
    expect(f).not.toContain("<mark");
    expect(trialScreen(view, ui({ selected: "D" }))).toContain("No expectation was written for this document, so nothing was checked. It is not counted as met.");
    expect(trialScreen(view, ui())).toContain('data-act="retry"');
    // A model the provider did not name is "could not be confirmed"; a different binding is a difference.
    const unconfirmed = { ...view, conditions: { ...view.conditions, rubricOnly: false, differences: [{ field: "modelsUnverified" as const, note: "the provider did not name the model" }] } };
    expect(trialScreen(unconfirmed, ui())).toContain("? The same conditions could not be confirmed.");
    const differs = { ...view, conditions: { ...view.conditions, rubricOnly: false, differences: [{ field: "binding" as const, note: "the judges differ" }, { field: "extraction" as const, note: "the text differs", cases: ["A"] }] } };
    expect(trialScreen(differs, ui())).toContain("! Not only the rubric differs.");
    expect(trialScreen(differs, ui())).toContain("<li>the text differs (A)</li>");
  });

  it("escapes what authors wrote, and builds the editor rows and the two-column rubric text", async () => {
    const t = await demo();
    const view = await trialView(t.store, t.intended.trial.id, { writable: true, env });
    const hostile = trialScreen({ ...view, test: { ...view.test, name: "<img src=x onerror=alert(1)>", intent: "<script>alert(2)</script>" } }, ui());
    expect(hostile).not.toMatch(/<img|<script/);
    const row = expectationRow("A", 0, { type: "asks_for", criterion: "q", fields: ["paid"] }, [{ id: "q", name: "Q", range: [0, 10], fields: ["paid", "since"] }]);
    expect(row).toContain('data-case="A" data-i="0"');
    expect(row).toContain('data-f="fields" value="paid"');
    expect(row).toContain("declared by the rubric: paid, since");
    expect(row).not.toContain("the total");
    expect(expectationRow("A", 1, { type: "hold" }, [])).toContain('<option value="" selected>the total</option>');
    const text = sideBySide("a\nb\nc", "a\nB\nc\nd");
    expect(text).toContain('<td class="del">b</td><td class="add">B</td>');
    expect(text).toContain('<td class="void">&nbsp;</td><td class="add">d</td>');
  });
});

describe("change-test API of verdict watch", () => {
  async function serve(opts: { readOnly?: string; engine?: boolean | Engine; store?: MemoryStore } = {}) {
    const store = opts.store ?? new MemoryStore();
    const engine = opts.engine === false ? undefined : opts.engine instanceof Engine ? opts.engine : new Engine({ store });
    const server = createWatchServer(store, "/data", { ...(engine ? { engine } : {}), ...(opts.readOnly ? { readOnly: opts.readOnly } : {}) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await (await fetch(`${base}/change-tests`)).text();
    const token = /startChange\("([0-9a-f]+)"/.exec(page)![1]!;
    const get = async (path: string) => { const res = await fetch(`${base}/api/change/${path}`); return { status: res.status, body: await res.json() as Record<string, never> }; };
    const post = async (path: string, body: unknown, headers: Record<string, string> = { "x-verdict-watch": token }) => {
      const res = await fetch(`${base}/api/change/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, never> };
    };
    const settled = async (trialId: string) => {
      for (let i = 0; i < 200; i++) {
        const { body } = await get(`trial?id=${trialId}`);
        if (!["queued", "running"].includes((body.trial as { status: string }).status)) return body;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("the trial did not finish");
    };
    return { store, server, base, page, token, get, post, settled, close: () => new Promise((r) => server.close(r)) };
  }

  it("serves the page with a token, and refuses writes that do not carry it or come from another origin", async () => {
    const s = await serve();
    expect(s.page).toContain("verdict watch — change tests");
    expect(s.page).toContain('aria-current="page">Change tests</a>');
    expect(s.token).toHaveLength(32);
    expect((await s.get("index")).body).toMatchObject({ tests: [], writable: true });
    expect(await s.post("demo", {}, {})).toMatchObject({ status: 403, body: { error: "this request did not come from the page verdict watch served" } });
    expect(await s.post("demo", {}, { "x-verdict-watch": "0".repeat(32) })).toMatchObject({ status: 403 });
    expect(await s.post("demo", {}, { "x-verdict-watch": s.token, origin: "https://evil.example" })).toMatchObject({ status: 403, body: { error: "requests from another origin are refused" } });
    expect(await s.post("demo", {}, { "x-verdict-watch": s.token, origin: "null" })).toMatchObject({ status: 403 });
    // A foreign host name that resolves to this machine (DNS rebinding) carries the token and is still refused.
    const rebound = await new Promise<number>((done) => {
      const req = request(`${s.base}/api/change/demo`, { method: "POST", headers: { host: "evil.example:4600", "x-verdict-watch": s.token, "content-type": "application/json" } }, (res) => { res.resume(); done(res.statusCode ?? 0); });
      req.end("{}");
    });
    expect(rebound).toBe(403);
    expect((await s.get("index")).body.tests).toEqual([]);
    expect(await s.post("demo", {}, { "x-verdict-watch": s.token, origin: s.base })).toMatchObject({ status: 200 });
    expect((await s.get("index")).body.tests).toHaveLength(2);
    expect((await s.get("nope")).status).toBe(404);
    expect(await s.get("trial?id=../../etc/passwd")).toMatchObject({ status: 400, body: { error: "trial id is missing or not an id" } });
    expect(await s.get("test?id=ct_missing")).toMatchObject({ status: 400, body: { error: expect.stringContaining("ct_missing is not in this data directory") } });
    expect(() => changePage("x", "\"+alert(1)+\"")).toThrow(/hex/);
    await s.close();
  });

  it("is read-only when asked or when it has no engine: stored results are served, nothing is written", async () => {
    for (const s of [await serve({ readOnly: "started with --read-only" }), await serve({ engine: false })]) {
      await seedChangeDemo(new Engine({ store: s.store }), s.store);
      const index = (await s.get("index")).body as unknown as { writable: boolean; notice: string; tests: Array<{ latest: { id: string } }> };
      expect(index).toMatchObject({ writable: false, notice: expect.stringMatching(/--read-only|without an engine/) });
      expect((await s.get(`trial?id=${index.tests[0]!.latest.id}`)).status).toBe(200);
      expect(await s.post("demo", {})).toMatchObject({ status: 403, body: { error: expect.stringMatching(/--read-only|without an engine/) } });
      await s.close();
    }
  });

  it("runs the whole flow: versions and documents in, a test, expectations, a trial, a re-verification and a follow-up", async () => {
    const s = await serve();
    const rubric = (points: number) => `name: Customers\ndefaultJudge: { type: decision, provider: mock, options: { script: [{ when: alpha, answers: { q: { choose: [all] } } }, { when: beta, answers: { q: { choose: [some] } } }] } }\n` +
      `criteria:\n  - id: q\n    name: Customers\n    scale: { type: numeric, min: 0, max: 10 }\n    choices: { all: all pay, some: some pay }\n    values: { all: 10, some: ${points} }\n`;
    const v1 = (await s.post("versions", { rubric: rubric(10) })).body.versionId as string, v2 = (await s.post("versions", { rubric: rubric(6) })).body.versionId as string;
    expect(await s.post("versions", { rubric: "name: x" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("invalid rubric") } });
    const docs = await s.post("documents", { name: "two", documents: [{ name: "alpha", text: "alpha pays" }, { name: "beta", text: "beta pays some" }] });
    const index = (await s.get("index")).body as unknown as { versions: Array<{ id: string }>; datasets: Array<{ id: string; cases: number }> };
    expect(index.versions.map((v) => v.id).sort()).toEqual([v1, v2].sort());
    expect(index.datasets).toMatchObject([{ id: docs.body.datasetVersionId, cases: 2 }]);

    const made = await s.post("tests", { name: "paying", intent: "count paying customers", baselineVersionId: v1, candidateVersionId: v2, datasetVersionId: docs.body.datasetVersionId });
    const testId = made.body.testId as string;
    expect(await s.post("tests", { name: "", baselineVersionId: v1, datasetVersionId: docs.body.datasetVersionId })).toMatchObject({ status: 400 });
    expect(await s.post("revisions", { testId, cases: { alpha: [{ type: "hold", criterion: "nope" }] } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("criterion nope is in neither version") } });
    expect((await s.post("revisions", { testId, cases: { alpha: [{ type: "hold", criterion: "q" }], beta: [{ type: "hold", criterion: "q" }] }, note: "first guess" })).body).toEqual({ revision: 2 });

    const started = await s.post("trials", { testId, candidateVersionId: v2 });
    expect(started).toMatchObject({ status: 200, body: { existing: false } });
    const trialId = started.body.trialId as string;
    const view = await s.settled(trialId) as unknown as { trial: { status: string; verifications: unknown[] }; verification: { cases: Record<string, { status: string }> }; cases: Array<{ caseId: string; changes: Record<string, { delta: number | null }> }> };
    expect(view.trial.status).toBe("completed");
    expect(Object.values(view.verification.cases).map((c) => c.status)).toEqual(["met", "unmet"]);
    expect(view.cases.map((c) => c.changes.q!.delta)).toEqual([0, -4]);

    // The expectation was wrong, not the rubric: revise it and verify the stored results again.
    await s.post("revisions", { testId, cases: { alpha: [{ type: "hold", criterion: "q" }], beta: [{ type: "decrease", criterion: "q", by: 4 }] } });
    expect((await s.post("reverify", { trialId })).body).toEqual({ verificationId: "ver_2" });
    const again = (await s.get(`trial?id=${trialId}`)).body as unknown as typeof view & { trial: { verifications: Array<{ id: string; kind: string; revision: number }> } };
    expect(again.trial.verifications).toMatchObject([{ id: "ver_1", kind: "after_run", revision: 2 }, { id: "ver_2", kind: "reverify", revision: 3 }]);
    expect(Object.values(again.verification.cases).map((c) => c.status)).toEqual(["met", "met"]);
    const first = (await s.get(`trial?id=${trialId}&verification=ver_1`)).body as unknown as typeof view;
    expect(Object.values(first.verification.cases).map((c) => c.status)).toEqual(["met", "unmet"]);

    const follow = await s.post("follow-ups", { testId, trialId, caseId: "beta", note: "ask the programme owner" });
    expect(follow.body.followUps).toMatchObject([{ caseId: "beta", note: "ask the programme owner" }]);
    expect((await s.post("follow-ups", { testId, resolve: (follow.body.followUps as Array<{ id: string }>)[0]!.id })).body.followUps).toMatchObject([{ resolvedAt: expect.any(String) }]);
    expect(await s.post("follow-ups", { testId })).toMatchObject({ status: 400 });

    const retried = await s.post("trials", { testId, candidateVersionId: v2, origin: { kind: "rerun", of: trialId } });
    expect(retried.body.trialId).not.toBe(trialId);
    await s.settled(retried.body.trialId as string);
    expect(await s.post("cancel", { trialId })).toMatchObject({ status: 200, body: { cancelling: false } });
    expect(((await s.get(`test?id=${testId}`)).body as unknown as { trials: unknown[]; test: { revisions: unknown[] } })).toMatchObject({ trials: { length: 2 }, test: { revisions: { length: 3 } } });
    await s.close();
  });

  it("starts one trial for two requests at once, shows it while it runs, and cancels it on request", async () => {
    const store = new MemoryStore();
    const { tests } = await seedChangeDemo(new Engine({ store }), store);
    // A judge that does not answer until released, so the trial is still running when the second request arrives.
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const engine = new Engine({ store });
    const evaluate = engine.evaluate.bind(engine);
    engine.evaluate = async (...args) => { await held; return evaluate(...args); };
    const s = await serve({ store, engine });
    const body = { testId: tests[0]!.test.id, candidateVersionId: tests[0]!.trial.candidate.versionId, reuseBaseline: false };
    const [first, second] = await Promise.all([s.post("trials", body), s.post("trials", body)]);
    expect(first.body).toMatchObject({ existing: false });
    expect(second.body).toEqual({ trialId: first.body.trialId, existing: true });
    const running = (await s.get(`trial?id=${first.body.trialId}`)).body as unknown as { trial: { status: string; progress: { total: number; done: number } }; verification?: unknown; cases: Array<{ head: { execution: string } }> };
    expect(running.trial).toMatchObject({ status: "running", progress: { total: 6, done: 0 } });
    expect(running.verification).toBeUndefined();
    expect(running.cases.map((c) => c.head.execution).every((x) => x === "running" || x === "queued")).toBe(true);
    expect(await s.post("cancel", { trialId: first.body.trialId })).toMatchObject({ body: { cancelling: true } });
    release();
    const ended = await s.settled(first.body.trialId as string) as unknown as { trial: { status: string; progress: { cancelled: number } }; verification: { summary: { verification: { met: number; verifiable: number } } } };
    expect(ended.trial.status).toBe("cancelled");
    expect(ended.trial.progress.cancelled).toBeGreaterThan(0);
    expect(ended.verification.summary.verification.verifiable).toBeLessThan(3);
    await s.close();
  });

  it("ends a trial left behind by a process that stopped, the next time it is read", async () => {
    const s = await serve();
    const { tests } = await seedChangeDemo(new Engine({ store: s.store }), s.store);
    const { createTrial } = await import("@verdict-ai/core");
    const { trial } = await createTrial(s.store, tests[0]!.test.id, tests[0]!.trial.candidate.versionId);
    await s.store.putTrial({ ...trial, status: "running", runner: "pid:999999999", createdAt: "2026-01-01T00:00:00.000Z" });
    const view = (await s.get(`trial?id=${trial.id}`)).body as unknown as { trial: { status: string; error: string } };
    expect(view.trial).toMatchObject({ status: "cancelled", error: "interrupted: the process that was running this trial stopped" });
    await s.close();
  });
});

describe("verdict change-test", () => {
  const rubric = (points: number) => `name: Customers
defaultJudge: { type: decision, provider: mock, options: { script: [{ when: alpha, answers: { q: { choose: [all] } } }, { when: beta, answers: { q: { choose: [some] } } }] } }
criteria:
  - { id: q, name: Customers, scale: { type: numeric, min: 0, max: 10 }, choices: { all: all pay, some: some pay }, values: { all: 10, some: ${points} } }
`;
  const cases = [{ id: "alpha", name: "alpha", inputs: [{ type: "text", text: "alpha pays" }] }, { id: "beta", name: "beta", inputs: [{ type: "text", text: "beta pays some" }] }].map((c) => JSON.stringify(c)).join("\n");
  const expectations = "intent: count paying customers\ncases:\n  alpha: [{ type: hold, criterion: q }]\n  beta: [{ type: decrease, criterion: q, by: 4 }]\n";

  function setup() {
    const files = new Map<string, string>([["v1.yaml", rubric(10)], ["v2.yaml", rubric(6)], ["v3.yaml", rubric(9)], ["docs.jsonl", cases], ["expect.yaml", expectations], ["hold.yaml", "cases:\n  beta: [{ type: hold, criterion: q }]\n"]].map(([k, v]) => [resolve(k!), v!]));
    const engine = new Engine();
    const out = vi.fn(), fail = vi.fn(), warn = vi.fn(), exitCode = vi.fn();
    const read = async (p: string) => files.get(resolve(p));
    const deps: VersionDependencies = {
      engine: () => engine, remote: () => undefined, out, fail, warn, exitCode,
      readText: async (p) => { const t = await read(p); if (t === undefined) throw new Error(`missing ${p}`); return t; },
      readBytes: async (p) => new TextEncoder().encode((await read(p)) ?? ""),
      lockIo: { read, write: async (p, t) => { files.set(resolve(p), t); } },
      writeNew: async (p, t) => { files.set(resolve(p), t); },
    };
    const program = new Command();
    registerChangeTest(program, deps);
    const run = async (...args: string[]) => { out.mockClear(); warn.mockClear(); await program.parseAsync(["change-test", ...args], { from: "user" }); return out.mock.calls.map((c) => String(c[0])); };
    return { run, warn, exitCode, engine };
  }

  it("keeps a test from files, runs a candidate against it and prints why each expectation held", async () => {
    const t = setup();
    const created = await t.run("create", "--base", "v1.yaml", "--head", "v2.yaml", "-d", "docs.jsonl", "--expect", "expect.yaml", "--name", "paying");
    expect(created[0]).toMatch(/^change test ct_\w+: paying — 2 documents, 2 expectations, baseline rv_\w+$/);
    const lines = await t.run("run", "paying");
    expect(lines[0]).toMatch(/^trial trial_\w+: completed · rv_\w+ → rv_\w+ · 2 documents · expectations revision 1$/);
    expect(lines[1]).toBe("conditions: the same on both sides; differences come from the rubric");
    expect(lines[2]).toBe("judge: scripted mock — not a model's judgement");
    expect(lines).toContain("  ✓ met              beta   q 10 → 6 (-4)");
    expect(lines).toContain("      ✓ met: q went 10 → 6 (-4); expected a drop of at least 4");
    expect(lines.at(-1)).toBe("2 of 2 verifiable cases met; 2 in all (not comparable 0, needs review 0, without expectations 0)");
    expect(t.warn.mock.calls.at(-1)![0]).toMatch(/^see it in `verdict watch`: http:\/\/127\.0\.0\.1:4600\/change-tests\?trial=trial_\w+$/);
    expect(t.exitCode).not.toHaveBeenCalled();

    // A later candidate is measured from the same baseline, whose stored results are shown again; a miss can fail a job.
    const later = await t.run("run", "paying", "--head", "v3.yaml", "--fail-on", "unmet");
    expect(t.warn.mock.calls.map((c) => String(c[0]))).toContain("showing 2 stored baseline results again; --rerun-baseline to evaluate them again");
    expect(later).toContain("      ✗ not met: q went 10 → 9 (-1); expected a drop of at least 4");
    expect(t.exitCode).toHaveBeenCalledWith(1);
    await expect(t.run("run", "paying", "--fail-on", "sometimes")).rejects.toThrow(/unknown --fail-on status sometimes/);
    await expect(t.run("run", "nothing")).rejects.toThrow(/no change test nothing/);
  });

  it("revises expectations and verifies a stored trial again without a judge, and lists what is kept", async () => {
    const t = setup();
    await t.run("create", "--base", "v1.yaml", "--head", "v2.yaml", "-d", "docs.jsonl", "--expect", "expect.yaml", "--name", "paying");
    const ran = JSON.parse((await t.run("run", "paying", "--json"))[0]!) as { trial: { id: string } };
    expect((await t.run("expect", "paying", "--file", "hold.yaml", "--note", "beta should hold"))[0]).toMatch(/revision 2 saved/);
    const calls = vi.spyOn(t.engine, "evaluate");
    const again = await t.run("reverify", ran.trial.id);
    expect(calls).not.toHaveBeenCalled();
    expect(again[0]).toMatch(/expectations revision 2$/);
    expect(again).toContain("  ○ not verified     alpha   q 10 → 10 (0)");
    expect(again).toContain("      ✗ not met: q went 10 → 6 (-4); expected no change");
    expect((await t.run("list"))[0]).toMatch(/^ct_\w+ {2}paying — revision 2; latest trial trial_\w+ completed, 0 of 1 verifiable cases met$/);
  });

  it("makes the demo tests and says they are a scripted mock", async () => {
    const t = setup();
    const lines = await t.run("demo");
    expect(lines.filter((l) => l.startsWith("created: Demo"))).toHaveLength(2);
    expect(lines).toContain("  ✓ met              B · 무료 실증 고객 3곳   customer_validation 10 → 6 (-4)");
    expect(lines).toContain("  ✓ met              C · 고객 3곳, 유료 여부 미기재   customer_validation 10 → — (no score: it asks for more information)");
    expect(lines).toContain("judge: scripted mock — not a model's judgement");
    expect((await t.run("demo")).filter((l) => l.startsWith("already there: Demo"))).toHaveLength(2);
    expect((await t.run("list")).every((l) => l.includes("[demo]"))).toBe(true);
  });
});
