/**
 * Browser code of a trial's result screen: what ran and under which conditions, the three tallies, the change chart,
 * the case table and one case's detail with its evidence. Shipped with `toString()` (see change-client.ts for the
 * rules). A change in points is neither good nor bad here: direction is drawn with a sign and a pattern, and whether
 * the test's expectation held is a separate mark. A score that is open is never drawn at zero.
 */
import type { CriterionObservation, ExpectationResult, ScoreChange, SideObservation } from "@verdict-ai/core";
import { escapeHtml } from "./client.js";
import { changeItem, demoBadge, expectationText, num, signed, stateText, statusChip, trialStatusText, when } from "./change-client.js";
import type { CaseRow, CriterionOption, TrialView, VersionView } from "./change-state.js";

export interface ResultUi { target: string; sort: string; filter: string; selected?: string }

export function caseStatus(view: TrialView, caseId: string): string {
  return view.verification?.cases[caseId]?.status ?? "pending";
}

/** A score with its maximum, or the state that explains why there is none. Never a zero for a missing score. */
export function scoreCell(side: SideObservation, change: ScoreChange, which: "base" | "head"): string {
  const score = which === "base" ? change.base : change.head, range = which === "base" ? change.baseRange : change.headRange;
  const reused = side.reusedFrom ? ' <span class="chip" title="Shown again from an earlier trial; not evaluated again">reused</span>' : "";
  if (side.execution !== "completed") {
    const text: Record<string, string> = { failed: "failed", invalid_output: "invalid output", cancelled: "cancelled", queued: "queued", running: "running…" };
    return `<span class="nos ex-${escapeHtml(side.execution)}">${text[side.execution] ?? escapeHtml(side.execution)}</span>${reused}`;
  }
  if (score === null) return `<span class="nos">${escapeHtml(stateText(side.state) === "scored" ? "no score" : stateText(side.state))}</span>${range ? ` <span class="muted">— / ${num(range[1])}</span>` : ""}${reused}`;
  return `<b class="sc">${num(score)}</b>${range ? ` <span class="muted">/ ${num(range[1])}</span>` : ""}${reused}`;
}

/** Why a row has no difference, in two or three words; the full reason is in the chart's list and in the detail. */
export function noChangeNote(row: CaseRow, change: ScoreChange): string {
  const text: Record<string, string> = { failed: "failed", invalid_output: "stored invalid output", cancelled: "was cancelled", queued: "is queued", running: "is running" };
  if (row.head.execution !== "completed") return `candidate ${text[row.head.execution] ?? row.head.execution}`;
  if (row.base.execution !== "completed") return `baseline ${text[row.base.execution] ?? row.base.execution}`;
  if (change.head === null) return "candidate score open";
  if (change.base === null) return "no baseline score";
  return "scales differ";
}

export function stateChange(row: CaseRow): string {
  const b = row.base.execution === "completed" ? stateText(row.base.state) : "—", h = row.head.execution === "completed" ? stateText(row.head.state) : "—";
  return b === h ? escapeHtml(h) : `${escapeHtml(b)} → <b>${escapeHtml(h)}</b>`;
}

/** Rows in the order asked for. Cases without a difference sort after those with one; ties keep document order. */
export function sortRows(view: TrialView, ui: ResultUi): CaseRow[] {
  const delta = (r: CaseRow) => r.changes[ui.target]?.delta ?? null;
  const rank = ["unmet", "needs_review", "incomparable", "unverified", "pending", "met"];
  const rows = view.cases.filter((r) => !ui.filter || caseStatus(view, r.caseId) === ui.filter);
  const by = (value: (r: CaseRow) => number | null, direction: number) => (a: CaseRow, b: CaseRow) => {
    const x = value(a), y = value(b);
    return x === null || y === null ? Number(x === null) - Number(y === null) : (x - y) * direction;
  };
  if (ui.sort === "drop") return [...rows].sort(by(delta, 1));
  if (ui.sort === "rise") return [...rows].sort(by(delta, -1));
  if (ui.sort === "status") return [...rows].sort((a, b) => rank.indexOf(caseStatus(view, a.caseId)) - rank.indexOf(caseStatus(view, b.caseId)));
  return rows;
}

export function caseTable(view: TrialView, ui: ResultUi): string {
  const rows = sortRows(view, ui);
  const body = rows.map((r) => {
    const change = r.changes[ui.target]!;
    const tally = view.verification?.cases[r.caseId]?.expectations ?? [];
    const met = tally.filter((e) => e.status === "met").length;
    const delta = change.delta === null ? `<span class="nos">—</span><small class="muted">${escapeHtml(noChangeNote(r, change))}</small>` : `<b class="dl">${signed(change.delta)}</b>`;
    const expected = r.expectations.length ? r.expectations.map(expectationText).join("") : '<span class="muted">none written</span>';
    const flag = r.followUp ? ' <span class="chip warn">follow up</span>' : "";
    return `<tr class="${r.caseId === ui.selected ? "sel" : ""}" data-case="${escapeHtml(r.caseId)}"><td data-l="Document"><button class="rowbtn" data-case="${escapeHtml(r.caseId)}" aria-pressed="${r.caseId === ui.selected}">${escapeHtml(r.name)}</button>${flag}</td>` +
      `<td data-l="Baseline">${scoreCell(r.base, change, "base")}</td><td data-l="Candidate">${scoreCell(r.head, change, "head")}</td><td data-l="Change">${delta}</td>` +
      `<td data-l="Judgment state">${stateChange(r)}</td><td data-l="Expected">${expected}</td>` +
      `<td data-l="Verification">${statusChip(caseStatus(view, r.caseId))}${tally.length ? ` <small class="muted">${met} of ${tally.length} expectation${tally.length === 1 ? "" : "s"}</small>` : ""}</td></tr>`;
  }).join("");
  return `<div class="tbl-wrap"><table class="cases"><thead><tr><th>Document</th><th>Baseline</th><th>Candidate</th><th>Change</th><th>State</th><th>Expected</th><th>Verification</th></tr></thead>` +
    `<tbody>${body || '<tr><td colspan="7" class="muted">No case has this status.</td></tr>'}</tbody></table></div>`;
}

export function tableControls(view: TrialView, ui: ResultUi): string {
  const opt = (value: string, label: string, chosen: string) => `<option value="${escapeHtml(value)}"${value === chosen ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const statuses: Array<[string, string]> = [["unmet", "Not met"], ["needs_review", "Needs review"], ["incomparable", "Not comparable"], ["unverified", "Not verified"], ["met", "Met"]];
  const counts = (s: string) => view.cases.filter((r) => caseStatus(view, r.caseId) === s).length;
  const shown = sortRows(view, ui).length;
  return `<div class="controls"><label>Score <select id="target">${view.targets.map((t) => opt(t.id, t.label, ui.target)).join("")}</select></label>` +
    `<label>Sort <select id="sort">${opt("order", "document order", ui.sort)}${opt("status", "verification: mismatches first", ui.sort)}${opt("drop", "change: largest drop first", ui.sort)}${opt("rise", "change: largest rise first", ui.sort)}</select></label>` +
    `<label>Show <select id="filter">${opt("", "all cases", ui.filter)}${statuses.map(([s, l]) => opt(s, `${l} (${counts(s)})`, ui.filter)).join("")}</select></label>` +
    `<span class="muted" role="status">Showing ${shown} of ${view.cases.length} cases</span></div>`;
}

/**
 * Changes around zero: a drop is hatched and to the left, a rise solid and to the right, and the mark at the end
 * says whether the expectation held. Cases with no difference to take are listed underneath with the reason.
 */
export function deltaChart(view: TrialView, ui: ResultUi): string {
  const rows = sortRows(view, { ...ui, filter: "" });
  const plotted = rows.filter((r) => r.changes[ui.target]!.delta !== null), rest = rows.filter((r) => r.changes[ui.target]!.delta === null);
  const max = Math.max(1e-9, ...plotted.map((r) => Math.abs(r.changes[ui.target]!.delta!)));
  const bar = (r: CaseRow) => {
    const d = r.changes[ui.target]!.delta!;
    const width = Math.abs(d) / max * 50;
    const fill = d === 0 ? '<i class="zdot"></i>' : `<i class="fill ${d < 0 ? "down" : "up"}" style="${d < 0 ? `right:50%` : `left:50%`};width:${width}%"></i>`;
    return `<button class="cbar${r.caseId === ui.selected ? " sel" : ""}" data-case="${escapeHtml(r.caseId)}" aria-pressed="${r.caseId === ui.selected}" aria-label="${escapeHtml(r.name)}: ${d === 0 ? "no change" : `${d < 0 ? "drop" : "rise"} of ${num(Math.abs(d))}`}, ${escapeHtml(caseStatus(view, r.caseId).replace("_", " "))}">` +
      `<span class="bl">${escapeHtml(r.name)}</span><span class="track"><i class="zero"></i>${fill}</span><span class="bv">${signed(d)}</span>${statusChip(caseStatus(view, r.caseId))}</button>`;
  };
  const none = rest.length ? `<div class="noplot"><div class="sh">No difference to plot (${rest.length}) — not drawn at zero</div>${rest.map((r) =>
    `<button class="cbar flat${r.caseId === ui.selected ? " sel" : ""}" data-case="${escapeHtml(r.caseId)}" aria-pressed="${r.caseId === ui.selected}"><span class="bl">${escapeHtml(r.name)}</span><span class="because">${escapeHtml(r.changes[ui.target]!.reason ?? "no difference")}</span>${statusChip(caseStatus(view, r.caseId))}</button>`).join("")}</div>` : "";
  const label = view.targets.find((t) => t.id === ui.target)?.label ?? ui.target;
  const chart = plotted.length ? `<div class="bars" role="group" aria-label="Change in ${escapeHtml(label)} per document">${plotted.map(bar).join("")}</div>` : `<div class="muted">No case has a difference in ${escapeHtml(label)} to plot.</div>`;
  return `<div class="chart"><div class="sh">Change in ${escapeHtml(label)}: candidate minus baseline</div>${chart}` +
    `<div class="legend"><span><i class="fill down sw"></i> drop</span><span><i class="fill up sw"></i> rise</span><span>The mark says whether the expectation held. A drop or a rise is neither good nor bad by itself.</span></div>${none}</div>`;
}

/** Documents by criteria, when there is more than one criterion to look across. */
export function criteriaMatrix(view: TrialView, ui: ResultUi): string {
  const criteria = view.targets.filter((t) => t.id !== "total");
  if (criteria.length < 2) return "";
  const cell = (r: CaseRow, id: string) => {
    const c = r.changes[id]!;
    return c.delta === null ? `<td class="nos" title="${escapeHtml(c.reason ?? "")}">—</td>` : `<td class="${c.delta < 0 ? "mdown" : c.delta > 0 ? "mup" : ""}">${c.delta === 0 ? "0" : `${c.delta < 0 ? "▼" : "▲"} ${signed(c.delta)}`}</td>`;
  };
  return `<details class="fold" open><summary>Change per criterion (${view.cases.length} × ${criteria.length})</summary><div class="tbl-wrap"><table class="matrix"><thead><tr><th>Document</th>${criteria.map((c) => `<th>${escapeHtml(c.id)}</th>`).join("")}</tr></thead>` +
    `<tbody>${view.cases.map((r) => `<tr><th><button class="rowbtn" data-case="${escapeHtml(r.caseId)}" aria-pressed="${r.caseId === ui.selected}">${escapeHtml(r.name)}</button></th>${criteria.map((c) => cell(r, c.id)).join("")}</tr>`).join("")}</tbody></table></div>` +
    `<p class="muted">— means there is no difference to take (an open score, a failed evaluation, a new criterion or a changed scale). ▼ and ▲ show direction only.</p></details>`;
}

export function conditionsBanner(view: TrialView): string {
  const c = view.conditions;
  const mock = c.mock ? `<div class="banner demo">${c.scripted ? "Scripted mock judge" : "Mock judge"}: these answers ${c.scripted ? "are written into the rubric's judge options" : "come from a deterministic stand-in"}. They are not a model's judgement.</div>` : "";
  const same = c.rubricOnly
    ? `<div class="banner ok"><b>✓ Same conditions.</b> The same documents, the same judges and the same extracted text: differences come from the rubric.</div>`
    : `<div class="banner warn"><b>${c.differences.every((d) => d.field === "modelsUnverified") ? "? The same conditions could not be confirmed." : "! Not only the rubric differs."}</b> Do not read these results as the rubric change alone:<ul>${c.differences.map((d) => `<li>${escapeHtml(d.note)}${d.cases?.length ? ` (${escapeHtml(d.cases.join(", "))})` : ""}</li>`).join("")}</ul></div>`;
  const models = (list: typeof c.models.base) => list.map((m) => `${m.provider}/${m.resolved ?? m.requested ?? "?"}${m.verified ? "" : " (not named by the provider)"}`).join(", ") || "none recorded";
  const t = view.trial;
  const detail = `<details class="fold"><summary>Run details</summary><dl class="kv"><dt>Trial</dt><dd><code>${escapeHtml(t.id)}</code>${t.origin.kind === "new" ? "" : ` — ${escapeHtml(t.origin.kind)} of <a href="/change-tests?trial=${escapeHtml(t.origin.of)}"><code>${escapeHtml(t.origin.of)}</code></a>`}</dd>` +
    `<dt>Started / finished</dt><dd>${escapeHtml(when(t.startedAt))} / ${escapeHtml(when(t.finishedAt))}</dd>` +
    `<dt>Baseline</dt><dd><code>${escapeHtml(view.baseline.id)}</code> ${escapeHtml(view.baseline.name)} v${escapeHtml(view.baseline.version)} — answered by ${escapeHtml(models(c.models.base))}</dd>` +
    `<dt>Candidate</dt><dd><code>${escapeHtml(view.candidate.id)}</code> ${escapeHtml(view.candidate.name)} v${escapeHtml(view.candidate.version)} — answered by ${escapeHtml(models(c.models.head))}</dd>` +
    `<dt>Evaluations</dt><dd>${t.progress.done} of ${t.progress.total} completed, ${t.progress.failed} failed, ${t.progress.cancelled} cancelled; ${t.progress.reused} shown again from an earlier trial</dd>` +
    `<dt>Rubric changes</dt><dd>${view.changes.length ? `<ul class="changes">${view.changes.map(changeItem).join("")}</ul>` : "none"}</dd></dl></details>`;
  return `${mock}${same}${detail}`;
}

export function summaryTiles(view: TrialView): string {
  const s = view.verification?.summary;
  if (!s) return `<div class="panel pad"><div class="muted">Not verified yet: the trial is still ${escapeHtml(trialStatusText(view.trial))}.</div></div>`;
  const v = s.verification, j = s.judgment, x = s.execution;
  const left = [v.needs_review ? `${v.needs_review} needs review` : "", v.incomparable ? `${v.incomparable} not comparable` : "", v.unverified ? `${v.unverified} without expectations` : ""].filter(Boolean);
  const tile = (title: string, body: string) => `<div class="tile"><div class="sh">${title}</div>${body}</div>`;
  const line = (n: number, label: string, cls = "") => `<div class="tl ${cls}"><b>${n}</b> ${label}</div>`;
  return `<div class="tiles">` +
    tile("Execution — did the evaluations run?", `${line(x.evaluated, `of ${s.cases} cases evaluated on both sides`)}${line(x.failed, "failed or stored invalid output")}${line(x.unfinished, "unfinished or cancelled")}`) +
    tile("Judgment — what the candidate could decide", `${line(j.scored, "scored")}${line(j.needs_info, `need information${j.newlyNeedsInfo ? ` (${j.newlyNeedsInfo} newly, compared with the baseline)` : ""}`)}${line(j.abstained, "abstained")}${line(j.none, "not judged")}`) +
    tile("Verification — did your expectations hold?", `<div class="rate"><b>${v.met} of ${v.verifiable}</b> verifiable cases met</div><div class="muted">${s.cases} cases in all${left.length ? `; left out of the rate: ${left.join(", ")}` : ""}.</div>` +
      `<div class="counts">${statusChip("met")} ${v.met} ${statusChip("unmet")} ${v.unmet} ${statusChip("needs_review")} ${v.needs_review} ${statusChip("incomparable")} ${v.incomparable} ${statusChip("unverified")} ${v.unverified}</div>`) +
    `</div><p class="muted">These are three separate counts of the same ${s.cases} cases. They are not meant to add up to each other. “Met” means the test's expectation held, not that a document passed.</p>`;
}

export function expectationResult(r: ExpectationResult, text: string): string {
  return `<li>${statusChip(r.status)} ${text}<div class="because">${escapeHtml(r.message)}${r.caveat ? ` <span class="chip warn">note: ${escapeHtml(r.caveat)}</span>` : ""}</div></li>`;
}

/** A criterion's score with its maximum, or the words for why there is none. */
export function criterionHead(o: CriterionObservation): string {
  const max = num(o.range[1]);
  if (o.execution !== "ok") {
    const text: Record<string, string> = { error: "judge failed", excluded: "excluded by a pre-screen check", missing: "no result" };
    return `<span class="nos">${text[o.execution]}</span>${o.error ? `<div class="because">${escapeHtml(o.error)}</div>` : ""}`;
  }
  if (o.score === null) return `<span class="nos">${escapeHtml(stateText(o.state))}</span> <span class="muted">— / ${max}</span>`;
  return `<b class="sc">${num(o.score)}</b> <span class="muted">/ ${max} · ${escapeHtml(stateText(o.state))}</span>`;
}

/** The judge's quotes: a button that jumps to the passage when it is in the document, a flagged line when it is not. */
export function quoteList(o: CriterionObservation): string {
  if (!o.quotes.length) return `<div class="muted">No quote: ${o.judges.some((j) => j.startsWith("decision")) ? "decision models return probabilities, not passages" : "the judge gave none"}.</div>`;
  const item = (q: CriterionObservation["quotes"][number]) => q.location
    ? `<li><button class="quote" data-mark="m-${q.location.inputIndex}-${q.location.start}-${q.location.end}">“${escapeHtml(q.text)}”</button> <span class="muted">${escapeHtml(q.location.label)}, line ${q.location.line}</span></li>`
    : `<li class="unlinked">“${escapeHtml(q.text)}” <span class="chip warn">✗ not found in the document — not linked</span></li>`;
  return `<div class="quotes"><span class="sh">quoted from the document</span><ul class="plain">${o.quotes.map(item).join("")}</ul></div>`;
}

/** The answer a judge chose, in the rubric's words, with what the rubric says it is worth. */
export function answerLine(o: CriterionObservation, spec: CriterionOption | undefined): string {
  if (o.choice === undefined) return "";
  const text = spec?.options?.[o.choice], worth = spec?.values?.[o.choice];
  return `<div class="ans"><span class="sh">answer</span> <code>${escapeHtml(o.choice)}</code>${text ? ` — ${escapeHtml(text)}` : ""}${worth !== undefined ? ` <span class="muted">(worth ${num(worth)} by the rubric)</span>` : ""}</div>`;
}

/** One criterion on one side: score with its maximum, state, the chosen answer in the rubric's words, reason, quotes. */
export function criterionCard(o: CriterionObservation, spec: CriterionOption | undefined): string {
  const asks = o.requests.length ? `<div class="asks"><span class="sh">asks for</span><ul class="plain">${o.requests.map((r) => `<li><code>${escapeHtml(r.field)}</code> — “${escapeHtml(r.question)}”</li>`).join("")}</ul></div>` : "";
  const open = o.reason && o.state !== "scored" ? `<div class="ans"><span class="sh">why it is open</span> ${escapeHtml(o.reason)}</div>` : "";
  const reason = o.rationale ? `<div class="reason"><span class="sh">judge's reason — said by the judge, not checked</span><p>${escapeHtml(o.rationale)}</p></div>` : "";
  const text = spec?.description ? `<div class="cdesc"><span class="sh">rubric text</span> ${escapeHtml(spec.description)}</div>` : "";
  return `<div class="ccard"><div class="cname">${escapeHtml(o.name)} <code>${escapeHtml(o.criterionId)}</code></div><div class="cscore">${criterionHead(o)}</div>` +
    `${text}${answerLine(o, spec)}${open}${asks}${reason}${quoteList(o)}<div class="muted">judged by ${escapeHtml(o.judges.join(", ") || "—")}</div></div>`;
}

/** A side whose evaluation did not finish or cannot be trusted: what happened, and that nothing is read as a score. */
export function blockedSide(title: string, side: SideObservation): string {
  const text: Record<string, string> = { failed: "The evaluation failed. Nothing is read as a score.", invalid_output: "The stored output failed validation. Nothing of it is read as a score.", cancelled: "Cancelled before it was evaluated.", queued: "Waiting to be evaluated.", running: "Being evaluated…" };
  const issues = side.issues.length ? `<ul class="plain">${side.issues.map((i) => `<li><code>${escapeHtml(i.code)}</code> ${escapeHtml(i.message)}</li>`).join("")}</ul>` : "";
  const bad = side.execution === "failed" || side.execution === "invalid_output";
  return `<div class="side"><h3>${escapeHtml(title)}</h3><div class="banner ${bad ? "bad" : ""}"><b>${escapeHtml(text[side.execution] ?? side.execution)}</b>${side.error ? `<div class="because">${escapeHtml(side.error)}</div>` : ""}${issues}</div></div>`;
}

/** The total, or — when a criterion keeps it open — that it is open, with the provisional number named as such. */
export function totalLine(total: NonNullable<SideObservation["total"]>): string {
  if (total.score !== null) return `<b class="sc">${num(total.score)}</b>${total.range ? ` <span class="muted">/ ${num(total.range[1])}</span>` : ""}`;
  const provisional = total.provisional === null ? "" : `; without ${total.openCriteria.length > 1 ? "them" : "it"} the rubric's <code>aggregation.missing: ${escapeHtml(total.missingPolicy)}</code> gives a provisional ${num(total.provisional)}, which is not compared`;
  return `<span class="nos">open</span> <span class="muted">${escapeHtml(total.openCriteria.join(", "))} not scored${provisional}</span>`;
}

export function sideColumn(title: string, side: SideObservation, version: VersionView, target: string): string {
  if (side.execution !== "completed") return blockedSide(title, side);
  const picked = side.criteria.filter((c) => target === "total" || c.criterionId === target);
  const cards = (picked.length ? picked : side.criteria).map((c) => criterionCard(c, version.criteria.find((x) => x.id === c.criterionId))).join("");
  const reused = side.reusedFrom ? ` <span class="chip">shown again from ${escapeHtml(side.reusedFrom.slice(0, 14))}; not evaluated again</span>` : "";
  return `<div class="side"><h3>${escapeHtml(title)} <code>${escapeHtml(version.id.slice(0, 11))}</code>${reused}</h3><div class="totalline"><span class="sh">total</span> ${totalLine(side.total!)}</div>${cards}</div>`;
}

/** The document as the judges read it, with every located quote marked so a quote button can jump to it. */
export function markedDocument(row: CaseRow): string {
  const quotes = [...row.head.criteria, ...row.base.criteria].flatMap((c) => c.quotes).flatMap((q) => (q.location ? [q.location] : []));
  if (!row.document.length) return `<div class="muted">The document text is not stored for this case (no evaluation completed).</div>`;
  return row.document.map((d) => {
    const ranges = quotes.filter((q) => q.inputIndex === d.inputIndex).sort((a, b) => a.start - b.start).filter((q, i, all) => i === 0 || q.start >= all[i - 1]!.end);
    let html = "", at = 0;
    for (const q of ranges) {
      html += `${escapeHtml(d.text.slice(at, q.start))}<mark id="m-${q.inputIndex}-${q.start}-${q.end}" tabindex="-1">${escapeHtml(d.text.slice(q.start, q.end))}</mark>`;
      at = q.end;
    }
    return `<div class="docbox"><div class="sh">${escapeHtml(d.label)}${d.truncated ? " (cut for display)" : ""}</div><pre class="doctext">${html}${escapeHtml(d.text.slice(at))}</pre></div>`;
  }).join("");
}

export function caseDetail(view: TrialView, ui: ResultUi): string {
  const row = view.cases.find((r) => r.caseId === ui.selected);
  if (!row) return `<aside class="panel detail empty-detail" id="detail"><div class="empty">Select a document in the chart or the table to see both judgements, the reasons and the evidence.</div></aside>`;
  const index = view.cases.indexOf(row);
  const results = view.verification?.cases[row.caseId];
  const expectations = !row.expectations.length
    ? `<p class="muted">${statusChip("unverified")} No expectation was written for this document, so nothing was checked. It is not counted as met.</p>`
    : results ? `<ul class="plain eres">${row.expectations.map((e) => { const r = results.expectations.find((x) => x.expectationId === e.id); return r ? expectationResult(r, expectationText(e)) : `<li>${statusChip("pending")} ${expectationText(e)}</li>`; }).join("")}</ul>`
      : `<ul class="plain eres">${row.expectations.map((e) => `<li>${statusChip("pending")} ${expectationText(e)}</li>`).join("")}</ul>`;
  const change = row.changes[ui.target]!;
  const delta = change.delta === null ? `no difference taken — ${escapeHtml(change.reason ?? "")}` : `${signed(change.delta)} (${num(change.base!)} → ${num(change.head!)})`;
  const follow = !view.writable ? "" : row.followUp
    ? `<div class="actions"><span class="chip warn">Marked to follow up${row.followUp.note ? `: ${escapeHtml(row.followUp.note)}` : ""}</span><button class="btn small" data-act="resolve-follow" data-id="${escapeHtml(row.followUp.id)}">Mark as done</button></div>`
    : `<div class="actions"><input id="follow-note" placeholder="Why look at this again? (optional)" maxlength="500"><button class="btn small" data-act="follow" data-case="${escapeHtml(row.caseId)}">Keep for follow-up</button><span class="muted">Keeps a note with the test. It changes no rubric and no score.</span></div>`;
  const nav = `<div class="dnav"><button class="btn small" data-act="prev"${index === 0 ? " disabled" : ""}>← Previous</button><button class="btn small" data-act="next"${index === view.cases.length - 1 ? " disabled" : ""}>Next →</button><a class="btn small" href="#cases">Back to the table</a></div>`;
  return `<aside class="panel detail" id="detail" aria-label="Detail of ${escapeHtml(row.name)}"><div class="dhead"><h2>${escapeHtml(row.name)}</h2>${statusChip(caseStatus(view, row.caseId))}${nav}</div>` +
    `<div class="pad"><div class="sh">Expected, and what happened</div>${expectations}<div class="muted">Change in ${escapeHtml(view.targets.find((t) => t.id === ui.target)?.label ?? ui.target)}: ${delta}</div>${follow}</div>` +
    `<div class="sides2">${sideColumn("Baseline", row.base, view.baseline, ui.target)}${sideColumn("Candidate", row.head, view.candidate, ui.target)}</div>` +
    `<div class="pad"><div class="sh">Document, as the judges read it</div>${markedDocument(row)}</div></aside>`;
}

export function trialActions(view: TrialView): string {
  if (!view.writable) return "";
  const t = view.trial;
  const running = t.status === "queued" || t.status === "running";
  const latest = view.test.revisions[view.test.revisions.length - 1]!;
  const picker = t.verifications.length > 1 ? `<label>Verification <select id="verification">${t.verifications.map((v) => `<option value="${escapeHtml(v.id)}"${v.id === view.verification?.id ? " selected" : ""}>${escapeHtml(v.id.replace("ver_", "#"))} · revision ${v.revision} · ${v.kind === "reverify" ? "re-verified, no judge called" : "after the run"} · ${escapeHtml(when(v.createdAt))}</option>`).join("")}</select></label>` : "";
  const sameBaseline = latest.baselineVersionId === view.baseline.id;
  const stale = view.verification && view.verification.revision !== latest.revision
    ? `<button class="btn" data-act="reverify"${sameBaseline ? "" : " disabled"}>Verify again against revision ${latest.revision}</button><span class="muted">${sameBaseline ? "Reads the stored results again. No judge is called, and the earlier verification is kept." : "Revision " + latest.revision + " measures from another baseline: run a new trial."}</span>` : "";
  const incomplete = t.progress.failed + t.progress.cancelled > 0;
  const buttons = running ? `<button class="btn" data-act="cancel">Cancel</button>` :
    `${incomplete ? `<button class="btn" data-act="retry">Retry what did not complete</button>` : ""}<button class="btn" data-act="rerun">Run everything again</button><span class="muted">Either makes a new trial; this one stays as it is.</span>`;
  return `<div class="actions">${picker}${stale}${buttons}</div>`;
}

export function progressBar(view: TrialView): string {
  const p = view.trial.progress;
  if (view.trial.status !== "queued" && view.trial.status !== "running") return view.trial.error ? `<div class="banner warn">${escapeHtml(view.trial.error)}</div>` : "";
  const finished = p.done + p.failed + p.cancelled;
  return `<div class="banner" role="status"><b>Running:</b> ${finished} of ${p.total} evaluations finished${p.failed ? `, ${p.failed} failed` : ""}. Finished cases are shown below as they arrive.` +
    `<div class="bar2"><i style="width:${p.total ? Math.round(finished / p.total * 100) : 0}%"></i></div></div>`;
}

export function trialScreen(view: TrialView, ui: ResultUi): string {
  const t = view.trial;
  const used = view.verification ? ` · checked against revision ${view.verification.revision}${view.verification.kind === "reverify" ? " (re-verified, no judge called)" : ""}` : "";
  const head = `<nav class="crumb"><a href="/change-tests">Change tests</a> / <a href="/change-tests?test=${escapeHtml(view.test.id)}">${escapeHtml(view.test.name)}</a> / Trial</nav>` +
    `<div class="title"><h1>${escapeHtml(view.test.name)}</h1>${demoBadge(view.test.demo)}<span class="chip">${escapeHtml(trialStatusText(t))}</span></div>` +
    `<div class="meta"><code>${escapeHtml(view.baseline.id.slice(0, 11))}</code> → <code>${escapeHtml(view.candidate.id.slice(0, 11))}</code> · ${view.cases.length} documents · run ${escapeHtml(when(t.startedAt ?? t.createdAt))}${used}</div>` +
    (view.test.intent ? `<p class="intent"><span class="sh">Stated intent (the author's words)</span> ${escapeHtml(view.test.intent)}</p>` : "");
  return `${head}${progressBar(view)}${conditionsBanner(view)}${summaryTiles(view)}${trialActions(view)}` +
    `<div class="work"><div class="main"><section class="panel pad">${tableControls(view, ui)}${deltaChart(view, ui)}</section>` +
    `<section class="panel" id="cases">${caseTable(view, ui)}</section>${criteriaMatrix(view, ui)}</div>${caseDetail(view, ui)}</div>`;
}

export const CHANGE_RESULT_FUNCTIONS = [caseStatus, scoreCell, noChangeNote, stateChange, sortRows, caseTable, tableControls, deltaChart, criteriaMatrix, conditionsBanner, summaryTiles, expectationResult, criterionHead, quoteList, answerLine, criterionCard, blockedSide, totalLine, sideColumn,
  markedDocument, caseDetail, trialActions, progressBar, trialScreen];
