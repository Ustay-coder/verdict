import { describe, expect, it } from "vitest";
import { createDatasetVersion, Engine, forkDraft, freezeRubric, MemoryStore, runCases, type CaseComparison, type GoldItem } from "@verdict-ai/core";
import { caseRow, compareScreen, foldRows, kindBanner, lineage, orderCases } from "../src/watch/compare-client.js";
import { compareView, type CompareView } from "../src/watch/compare-state.js";
import { comparePage } from "../src/watch/page.js";

// The mock decision provider picks the choice whose description shares the most words with the state.
const triage = { name: "Owning team", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "team", name: "Team", choices: { support: "How-to questions", billing: "Invoices and payments", engineering: "Bugs and outages" } }] };
const ticket = (id: string, text: string, team: string, extra: Partial<GoldItem> = {}): GoldItem => ({ id, name: id, inputs: [{ type: "text", text }], expected: { team }, ...extra });

async function twoRuns() {
  const store = new MemoryStore(), engine = new Engine({ store });
  const base = await freezeRubric(triage);
  const draft = forkDraft(base);
  draft.criteria[0]!.choices = { support: "How-to questions", billing: "Invoices, payments and refund requests", engineering: "Outages and crashes" };
  const head = await freezeRubric(draft, { parent: base, note: "refunds <b>are</b> billing" });
  const data = await createDatasetVersion([ticket("c1", "payments failed twice", "billing", { split: "evaluation", labelSource: "human" }), ticket("c2", "the app has bugs", "engineering"), ticket("c3", "refund please", "billing")], { name: "cases.jsonl" });
  for (const v of [base, head]) await store.putRubricVersion(v);
  await store.putDatasetVersion(data);
  const first = await runCases(engine, base, data);
  await store.putRun(first.run);
  await new Promise((r) => setTimeout(r, 5));
  const second = await runCases(engine, head, data);
  await store.putRun(second.run);
  return { store, base, head, data, first: first.run, second: second.run };
}

describe("compareView", () => {
  it("compares the newest run with the latest earlier run over the same inputs by default", async () => {
    const { store, base, head, data, first, second } = await twoRuns();
    const view = await compareView(store, {});
    expect(view.selection).toEqual({ base: first.id, head: second.id, labels: data.id });
    expect(view.comparison).toMatchObject({ kind: "rubric_change" });
    expect(view.comparison!.criteria[0]!.counts).toMatchObject({ fixed: 1, regressed: 1, kept_match: 1 });
    expect(view.versions).toMatchObject({ base: { id: base.id }, head: { id: head.id, parentVersionId: base.id, changeKinds: ["question_text"] } });
    expect(view.cases!.c1).toEqual({ name: "c1", preview: "payments failed twice", labelSource: "human", split: "evaluation" });
    expect(view.runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(view.runs[0]!.label).toMatch(/^Owning team · rv_\w{7} · cases\.jsonl · \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(view.labelSets).toEqual([{ id: data.id, name: "cases.jsonl" }]);
  });

  it("honours an explicit pair and explains, instead of failing, when there is nothing to compare", async () => {
    const { store, first, second } = await twoRuns();
    expect((await compareView(store, { base: second.id, head: first.id })).selection).toMatchObject({ base: second.id, head: first.id });
    expect(await compareView(store, { base: "run_missing", head: first.id })).toMatchObject({ notice: "run run_missing is not in this data directory" });
    expect(await compareView(store, { base: first.id, head: second.id, labels: "dsv_missing" })).toMatchObject({ notice: "label set dsv_missing is not in this data directory" });
    expect(await compareView(new MemoryStore(), {})).toMatchObject({ runs: [], notice: expect.stringMatching(/^No runs yet/) });
  });
});

describe("comparison screen", () => {
  it("leads with what kind of comparison it is, folds unchanged rubric lines, and escapes everything it prints", async () => {
    const { store } = await twoRuns();
    const html = compareScreen(await compareView(store, {}));
    expect(html.indexOf("Rubric change")).toBeLessThan(html.indexOf("agreement with the labels"));
    expect(html).toContain("head forked from the base:");
    expect(html).toContain("refunds &lt;b&gt;are&lt;/b&gt; billing");
    expect(html).not.toContain("<b>are</b>");
    expect(html).toMatch(/<div class="fold">\d+ unchanged lines<\/div>/);
    expect(html).toContain('<span class="chip bad">regressed 1</span>');
    expect(html).toContain("3 cases · both scored 3 · labelled 3");
  });

  it("orders cases so regressions, fixes and near-boundary moves come first", () => {
    const row = (caseId: string, cls: CaseComparison["class"], nearBoundary = false) => ({ caseId, class: cls, nearBoundary } as CaseComparison);
    expect(orderCases([row("a", "kept_match"), row("b", "fixed"), row("c", "kept_match", true), row("d", "regressed")]).map((r) => r.caseId)).toEqual(["d", "b", "c", "a"]);
  });

  it("shows both answer distributions in a case and marks one that moved close to flipping", () => {
    const side = (verdict: string, yes: number, gap: number) => ({ status: "scored" as const, verdict, agrees: true, gap, probabilities: { no: 1 - yes, yes } });
    const html = caseRow({ caseId: "a", class: "kept_match", expected: "yes", base: side("yes", 0.9, 0.4), head: side("yes", 0.58, 0.08), nearBoundary: true }, { name: "<a>", preview: "connect me" });
    expect(html).toContain("<b>&lt;a&gt;</b> yes → yes");
    expect(html).toContain("near boundary 0.4 → 0.08");
    expect(html).toContain("58%");
    expect(html).toContain("connect me");
  });

  it("says plainly when conditions differ and when labels were re-scored, and folds long unchanged runs", () => {
    const view = { runs: [], labelSets: [], comparison: { kind: "different_conditions", conditions: { same: false, diffs: [{ field: "bindingHash" }, { field: "judgmentHash" }] }, labels: { rescored: { base: true, head: false } } } } as unknown as CompareView;
    const banner = kindBanner(view);
    expect(banner).toContain("Different conditions");
    expect(banner).toContain("<code>bindingHash</code> <code>judgmentHash</code>");
    expect(banner).toContain("re-scored against these labels: base (no judge calls)");
    const rows = Array.from({ length: 10 }, (_, i) => ["=", `l${i}`] as ["=", string]);
    rows[5] = ["+", "new"];
    expect(foldRows(rows, 1)).toEqual([["…", "4 unchanged lines"], ["=", "l4"], ["+", "new"], ["=", "l6"], ["…", "3 unchanged lines"]]);
    expect(lineage({ id: "rv_a", rubricKey: "k", yaml: "" }, { id: "rv_b", rubricKey: "k", yaml: "" })).toBe("");
  });

  it("serves a page that loads the comparison script", () => {
    const page = comparePage("/data/<x>");
    expect(page).toContain("startCompare();");
    expect(page).toContain('<a href="/compare" class="on">Compare runs</a>');
    expect(page).not.toContain("<x>");
  });
});
