/**
 * Browser code of the comparison screen (`/compare` in `verdict watch`). Shipped with `toString()` next to the
 * functions of client.ts it uses (escapeHtml, percent, lineDiff, lineClass), so — as there — these functions may use
 * only each other, those, their parameters and browser globals. The builders are pure and unit-tested.
 * The order of the screen follows the design: what kind of comparison this is first, then what changed in the
 * rubric, then the cases that changed, with every rate next to its denominator.
 */
import type { CaseComparison, CaseSide, CriterionComparison } from "@verdict-ai/core";
import { escapeHtml, lineClass, lineDiff, percent } from "./client.js";
import type { CaseView, CompareView, VersionView } from "./compare-state.js";

export function kindBanner(view: CompareView): string {
  const cmp = view.comparison!;
  const text: Record<string, string> = {
    rubric_change: "Rubric change — only the rubric's judgment differs, so these results are the rubric's doing.",
    policy_change: "Policy change — the same answers read another way (threshold, values, weights or aggregation).",
    same_conditions: "Same conditions — a repeat of the same version on the same cases.",
    different_conditions: "Different conditions — something besides the rubric differs; read the cases, not the totals.",
  };
  const explained = cmp.kind === "rubric_change" ? ["judgmentHash", "questionsHash"] : cmp.kind === "policy_change" ? ["policyHash"] : [];
  const other = cmp.conditions.diffs.filter((d) => !explained.includes(d.field));
  const differs = other.length ? `<div class="differs">differs: ${other.map((d) => `<code>${escapeHtml(d.field)}</code>`).join(" ")}</div>` : "";
  const rescored = [cmp.labels.rescored.base ? "base" : "", cmp.labels.rescored.head ? "head" : ""].filter(Boolean).join(" and ");
  const labels = rescored ? `<div class="differs">re-scored against these labels: ${rescored} (no judge calls)</div>` : "";
  return `<div class="kind k-${escapeHtml(cmp.kind)}"><b>${escapeHtml(text[cmp.kind] ?? cmp.kind)}</b>${differs}${labels}</div>`;
}

export function picker(view: CompareView): string {
  const select = (name: string, chosen: string | undefined, options: Array<{ id: string; label: string }>) =>
    `<label>${name}<select name="${name}">${options.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === chosen ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select></label>`;
  const runs = view.runs.map((r) => ({ id: r.id, label: `${r.label} · ${r.status}` }));
  const labels = view.labelSets.map((l) => ({ id: l.id, label: l.name ? `${l.name} (${l.id.slice(0, 10)})` : l.id }));
  return `<form class="picker" id="pick">${select("base", view.selection?.base, runs)}${select("head", view.selection?.head, runs)}${labels.length ? select("labels", view.selection?.labels, labels) : ""}</form>`;
}

/**
 * Keeps changed lines and `context` lines around them; longer unchanged stretches fold into one "… n unchanged
 * lines" row, so a one-word edit in a long rubric is visible without scrolling.
 */
export function foldRows(rows: Array<["=" | "+" | "-", string]>, context: number): Array<["=" | "+" | "-" | "…", string]> {
  const near = rows.map((_, i) => rows.slice(Math.max(0, i - context), i + context + 1).some((r) => r[0] !== "="));
  const out: Array<["=" | "+" | "-" | "…", string]> = [];
  for (let i = 0; i < rows.length;) {
    if (near[i]) { out.push(rows[i]!); i++; continue; }
    let j = i;
    while (j < rows.length && !near[j]) j++;
    out.push(["…", `${j - i} unchanged line${j - i > 1 ? "s" : ""}`]);
    i = j;
  }
  return out;
}

/** The fork lineage of the head version, said plainly: its parent may or may not be the base of this comparison. */
export function lineage(base: VersionView, head: VersionView): string {
  if (!head.parentVersionId) return "";
  const parent = head.parentVersionId === base.id ? "the base" : escapeHtml(head.parentVersionId);
  const kinds = (head.changeKinds ?? []).map((k) => `<span class="chip">${escapeHtml(k)}</span>`).join("");
  const note = head.note ? `<span class="note">— ${escapeHtml(head.note)}</span>` : "";
  return `<div class="kinds"><span class="note">head forked from ${parent}:</span>${kinds}${note}</div>`;
}

/** Both rubric versions as one line diff, folded around the changes, with the head's fork lineage. */
export function rubricPanel(base: VersionView, head: VersionView): string {
  const rows = lineDiff(base.yaml, head.yaml);
  const changed = rows.some((r) => r[0] !== "=");
  const lines = foldRows(rows, 3).map(([kind, line]) => kind === "…"
    ? `<div class="fold">${escapeHtml(line)}</div>`
    : `<div class="${lineClass(kind, line)}">${escapeHtml(line) || "&nbsp;"}</div>`).join("");
  return `<div class="panel doc"><div class="hd"><b>${escapeHtml(base.id)} → ${escapeHtml(head.id)}</b><span>${changed ? "rubric changed" : "same rubric"}</span></div>` +
    `${lineage(base, head)}<pre>${lines}</pre></div>`;
}

/** The model's answer distribution on one side, one bar per level or option. */
export function probabilityBars(side: CaseSide): string {
  const entries = Object.entries(side.probabilities ?? {});
  if (!entries.length) return `<div class="muted">${escapeHtml(side.status)}${side.verdict !== null ? ` · ${escapeHtml(side.verdict)}` : ""}</div>`;
  return entries.map(([label, p]) => `<div class="pb"><span>${escapeHtml(label)}</span><span class="bar"><i style="width:${Math.round(p * 100)}%"></i></span><span>${percent(p)}</span></div>`).join("");
}

export function sideLabel(side: CaseSide): string {
  return side.status === "scored" ? escapeHtml(side.verdict) : `<i>${escapeHtml(side.status === "escalated" ? "asked a human" : side.status)}</i>`;
}

/** One case as an expandable row: verdicts and expectation on the line; text and both distributions inside. */
export function caseRow(row: CaseComparison, info: CaseView | undefined): string {
  const marks: Record<string, string> = { fixed: "✓", regressed: "✗", changed_unlabelled: "±", error: "!", missing: "?", escalated: "…", incomparable: "≠" };
  const mark = marks[row.class] ?? (row.nearBoundary ? "~" : "·");
  const expected = row.expected !== undefined ? ` <span class="muted">expected ${escapeHtml(row.expected)}</span>` : "";
  const near = row.nearBoundary ? ` <span class="chip warn">near boundary ${row.base.gap} → ${row.head.gap}</span>` : "";
  const meta = [info?.split, info?.labelSource && `label: ${info.labelSource}`, info?.kind].filter(Boolean).map((m) => `<span class="chip">${escapeHtml(m)}</span>`).join("");
  return `<details class="case c-${escapeHtml(row.class)}"><summary><span class="mark">${mark}</span><b>${escapeHtml(info?.name ?? row.name ?? row.caseId)}</b> ${sideLabel(row.base)} → ${sideLabel(row.head)}${expected}${near}</summary>` +
    `<div class="cbody"><pre class="preview">${escapeHtml(info?.preview ?? "")}</pre>${meta ? `<div>${meta}</div>` : ""}` +
    `<div class="sides"><div><div class="sh">base</div>${probabilityBars(row.base)}</div><div><div class="sh">head</div>${probabilityBars(row.head)}</div></div></div></details>`;
}

/** Cases worth reading first come first; unchanged ones last. */
export function orderCases(cases: CaseComparison[]): CaseComparison[] {
  const rank = ["regressed", "fixed", "changed_unlabelled", "error", "missing", "escalated", "incomparable", "kept_miss", "kept_match", "same_unlabelled"];
  const weight = (c: CaseComparison) => (c.nearBoundary ? 2.5 : rank.indexOf(c.class));
  return [...cases].sort((a, b) => weight(a) - weight(b));
}

export function criterionPanel(c: CriterionComparison, cases: Record<string, CaseView>): string {
  const n = c.counts;
  const headline = c.contract.same
    ? `<div class="agree"><span class="big">${percent(c.agreement.base ?? undefined)} → ${percent(c.agreement.head ?? undefined)}</span> <span class="muted">agreement with the labels, n=${c.agreement.n}</span></div>`
    : '<div class="gate">Answer contract changed (levels or options): no rates — cases side by side.</div>';
  const chip = (label: string, value: number, cls = "") => (value ? `<span class="chip ${cls}">${label} ${value}</span>` : "");
  const counts = [chip("regressed", n.regressed, "bad"), chip("fixed", n.fixed, "good"), chip("near boundary", n.nearBoundary, "warn"), chip("changed", n.changed_unlabelled),
    chip("errors", n.error, "bad"), chip("missing", n.missing), chip("asked a human", n.escalated), chip("kept", n.kept_match + n.kept_miss)].join("");
  const denominators = `<div class="muted denom">${n.cases} cases · both scored ${n.commonSucceeded} · labelled ${n.labelled}</div>`;
  return `<div class="panel crit-panel"><div class="score"><div class="cid">${escapeHtml(c.criterionId)}</div>${headline}<div class="counts">${counts}</div>${denominators}</div>` +
    `${orderCases(c.cases).map((row) => caseRow(row, cases[row.caseId])).join("")}</div>`;
}

export function compareScreen(view: CompareView): string {
  const top = `<div class="title"><h1>Compare runs</h1><span class="chip">${view.runs.length} stored runs</span></div>${view.runs.length ? picker(view) : ""}`;
  if (!view.comparison || !view.versions) return `${top}<div class="empty">${escapeHtml(view.notice ?? "Nothing to compare.")}</div>`;
  const cli = `<div class="muted cli">CLI: <code>verdict diff --base ${escapeHtml(view.selection!.base)} --head ${escapeHtml(view.selection!.head)}</code></div>`;
  return `${top}${kindBanner(view)}<div class="grid"><div>${rubricPanel(view.versions.base, view.versions.head)}${cli}</div>` +
    `<div>${view.comparison.criteria.map((c) => criterionPanel(c, view.cases ?? {})).join("")}</div></div>`;
}

/** Loads the comparison for the URL's query; changing a picker updates the URL and reloads. Read-only. */
export function startCompare(): void {
  const load = async () => {
    const app = document.querySelector<HTMLElement>("#app")!;
    try {
      const response = await fetch(`/api/compare${location.search}`, { cache: "no-store" });
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      app.innerHTML = compareScreen(JSON.parse(body) as CompareView);
      document.querySelector("#upd")!.textContent = `loaded ${new Date().toLocaleTimeString()}`;
      document.querySelector<HTMLFormElement>("#pick")?.addEventListener("change", (event) => {
        const params = new URLSearchParams(new FormData(event.currentTarget as HTMLFormElement) as unknown as Record<string, string>);
        // A new pair of runs may come from other label sets; let the server choose unless labels was the one changed.
        if ((event.target as HTMLSelectElement).name !== "labels") params.delete("labels");
        history.replaceState(null, "", `/compare?${params}`);
        void load();
      });
    } catch (error) {
      document.querySelector("#upd")!.textContent = `cannot load the comparison (${error instanceof Error ? error.message : String(error)})`;
    }
  };
  void load();
}

/** Everything the comparison page needs, shared helpers first. */
export const COMPARE_FUNCTIONS = [escapeHtml, percent, lineDiff, lineClass, kindBanner, picker, foldRows, lineage, rubricPanel, probabilityBars, sideLabel, caseRow, orderCases, criterionPanel, compareScreen, startCompare];
