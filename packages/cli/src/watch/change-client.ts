/**
 * Browser code of the change-test screens (`/change-tests` in `verdict watch`): the list, the new-test form and the
 * setup screen of one test. Shipped with `toString()` like client.ts, so these functions may use only each other,
 * the helpers listed in CHANGE_FUNCTIONS, their parameters and browser globals. The builders are pure and
 * unit-tested. State is never shown by colour alone: every status carries a mark and a word.
 */
import type { Expectation, RubricChange } from "@verdict-ai/core";
import { escapeHtml, lineDiff } from "./client.js";
import { foldRows } from "./compare-client.js";
import type { ChangeIndexView, CriterionOption, JudgeConnection, TestView, TrialSummary, VersionOption, VersionView } from "./change-state.js";

export type Draft = Record<string, Array<Record<string, unknown>>>;

/** A number as shown: at most two decimals. Comparisons never use this; they use the stored values. */
export function num(n: number): string { return String(Math.round(n * 100) / 100); }
export function signed(n: number): string {
  const v = Math.round(n * 100) / 100;
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0";
}
export function when(iso: string | undefined): string { return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—"; }

/** A verification status as a mark and a word, so it reads without colour. */
export function statusChip(status: string): string {
  const text: Record<string, string> = { met: "✓ Met", unmet: "✗ Not met", needs_review: "? Needs review", incomparable: "≠ Not comparable", unverified: "○ Not verified", pending: "… Pending" };
  return `<span class="vs vs-${escapeHtml(status)}">${text[status] ?? escapeHtml(status)}</span>`;
}

export function stateText(state: string | null | undefined): string {
  const text: Record<string, string> = { scored: "scored", needs_info: "needs information", abstained: "abstained" };
  return state ? text[state] ?? state : "not judged";
}

export function trialStatusText(t: TrialSummary): string {
  const text: Record<string, string> = { queued: "queued", running: "running", completed: "completed", partial: "partly completed", failed: "failed", cancelled: "cancelled" };
  return text[t.status] ?? t.status;
}

/** "2 of 4 verifiable cases met": the rate with its denominator, and why the rest are left out. */
export function metLine(t: TrialSummary): string {
  const s = t.summary;
  if (!s) return "not verified yet";
  const v = s.verification;
  const out = [v.incomparable ? `${v.incomparable} not comparable` : "", v.needs_review ? `${v.needs_review} needs review` : "", v.unverified ? `${v.unverified} without expectations` : ""].filter(Boolean);
  return `${v.met} of ${v.verifiable} verifiable case${v.verifiable === 1 ? "" : "s"} met` + (out.length ? ` · ${s.cases} in all, left out: ${out.join(", ")}` : ` · ${s.cases} in all`);
}

export function demoBadge(demo: boolean): string {
  return demo ? '<span class="chip demo" title="Invented documents judged by a scripted mock">Demo data</span>' : "";
}

/** " ≥ 4" when an amount was given, nothing when it was left at its default. */
export function amountText(n: number | undefined, prefix: string): string { return n ? `${prefix}${num(n)}` : ""; }

export function expectationText(e: Expectation): string {
  const say = (text: string) => `<span class="ex">${text} <i>${escapeHtml(e.criterion ?? "total")}</i></span>`;
  switch (e.type) {
    case "hold": return say(`holds${amountText(e.tolerance, " ±")}`);
    case "increase": return say(`rises${amountText(e.by, " ≥ ")}`);
    case "decrease": return say(`drops${amountText(e.by, " ≥ ")}`);
    case "not_lower": return say(`does not drop${amountText(e.tolerance, " beyond ")}`);
    case "not_higher": return say(`does not rise${amountText(e.tolerance, " beyond ")}`);
    case "range": return say(e.min === e.max ? `= ${num(e.min)}` : `${num(e.min)}–${num(e.max)}`);
    case "state": return say(`state: ${escapeHtml(stateText(e.state))}`);
    default: return say(`asks for ${escapeHtml(e.fields.join(", "))}`);
  }
}

/* ---- The list ---- */

export function testCard(t: ChangeIndexView["tests"][number]): string {
  const latest = t.latest
    ? `<a href="/change-tests?trial=${escapeHtml(t.latest.id)}">Latest trial</a>: ${escapeHtml(trialStatusText(t.latest))} · ${escapeHtml(metLine(t.latest))}`
    : "No trial yet";
  const follow = t.openFollowUps ? ` · <span class="chip warn">${t.openFollowUps} to follow up</span>` : "";
  return `<li class="panel tcard"><div class="row"><a class="tname" href="/change-tests?test=${escapeHtml(t.id)}">${escapeHtml(t.name)}</a>${demoBadge(t.demo)}</div>` +
    `${t.intent ? `<p class="intent">${escapeHtml(t.intent)}</p>` : ""}<div class="muted">${t.cases} document${t.cases === 1 ? "" : "s"} · expectations revision ${t.revision} · made ${escapeHtml(when(t.createdAt))}${follow}</div>` +
    `<div class="muted">${latest}</div></li>`;
}

export function indexScreen(view: ChangeIndexView): string {
  const head = `<div class="title"><h1>Change tests</h1><span class="chip">${view.tests.length} kept</span></div>` +
    `<p class="lede">A change test runs the same documents under two versions of a rubric and checks the result against expectations you wrote beforehand. ` +
    `“Met” means your expectation held. It does not mean a document passed, or that the rubric is right.</p>`;
  const off = view.writable ? "" : `<div class="banner warn">Read-only: ${escapeHtml(view.notice ?? "writes are off")}. Stored tests and results can still be read.</div>`;
  const actions = view.writable ? `<div class="actions"><a class="btn primary" href="/change-tests?new=1">New test</a><button class="btn" data-act="demo">Create the demo tests</button>` +
    `<span class="muted">The demo uses invented documents and a scripted mock judge: no model is called.</span></div>` : "";
  const list = view.tests.length
    ? `<ul class="tlist">${view.tests.map(testCard).join("")}</ul>`
    : `<div class="empty">No change tests yet.<br>Create the demo tests to see one, or start a new test from two frozen rubric versions and a set of documents.</div>`;
  return `${head}${off}${actions}${list}`;
}

/* ---- New test ---- */

export function selectField(label: string, name: string, options: Array<{ id: string; label: string }>, chosen?: string, hint?: string): string {
  const items = options.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === chosen ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtml(name)}" required>${items}</select>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</label>`;
}

export function newTestScreen(view: ChangeIndexView, picked: Record<string, string>): string {
  const crumb = `<nav class="crumb"><a href="/change-tests">Change tests</a> / New test</nav><div class="title"><h1>New change test</h1></div>`;
  if (!view.writable) return `${crumb}<div class="banner warn">Read-only: ${escapeHtml(view.notice ?? "writes are off")}.</div>`;
  const needs = [view.versions.length < 1 ? "a frozen rubric version" : "", view.datasets.length ? "" : "a document set"].filter(Boolean);
  const missing = needs.length ? `<div class="banner warn">Still needed: ${needs.join(" and ")}. Add them below, or from the command line with <code>verdict version freeze rubric.yaml</code> and <code>verdict change-test create</code>.</div>` : "";
  const form = `<form id="new-test" class="panel form">` +
    `<label class="field"><span>Name</span><input name="name" required maxlength="200" value="${escapeHtml(picked.name ?? "")}" placeholder="Tell paying customers from free pilots"></label>` +
    `<label class="field"><span>Intent of the change</span><textarea name="intent" rows="3" maxlength="4000" placeholder="What is the change meant to do? Written for people: no judge and no check reads it.">${escapeHtml(picked.intent ?? "")}</textarea></label>` +
    `<div class="two">${selectField("Baseline version (changes are measured from it)", "baselineVersionId", view.versions, picked.baselineVersionId)}` +
    `${selectField("Candidate version", "candidateVersionId", view.versions, picked.candidateVersionId ?? view.versions[0]?.id)}</div>` +
    `${selectField("Documents (the same set is evaluated under both versions)", "datasetVersionId", view.datasets, picked.datasetVersionId)}` +
    `<div class="actions"><button class="btn primary" type="submit"${needs.length ? " disabled" : ""}>Create test</button><span class="muted">Next: write what you expect of each document, then run.</span></div></form>`;
  const addVersion = `<details class="panel fold"><summary>Add a rubric version (paste YAML or JSON)</summary><form id="add-version" class="form">` +
    `<label class="field"><span>Rubric</span><textarea name="rubric" rows="10" required spellcheck="false" placeholder="name: …&#10;criteria:&#10;  - id: …"></textarea></label>` +
    `<div class="actions"><button class="btn" type="submit">Freeze and add</button><span class="muted">Freezing gives the rubric an id derived from its content; the same text always gets the same id.</span></div></form></details>`;
  const addDocs = `<details class="panel fold"><summary>Add documents (paste text)</summary><form id="add-documents" class="form"><label class="field"><span>Name of the set</span><input name="name" maxlength="120" placeholder="Applications, round 3"></label>` +
    `<div id="doc-list">${documentFields(0)}</div><div class="actions"><button class="btn" type="button" data-act="more-doc">Add another document</button><button class="btn" type="submit">Save the set</button>` +
    `<span class="muted">Files (PDF and others): put them in a cases file and use <code>verdict change-test create</code>.</span></div></form></details>`;
  return `${crumb}${missing}${form}${addVersion}${addDocs}`;
}

export function documentFields(i: number): string {
  return `<fieldset class="docf"><legend>Document ${i + 1}</legend><label class="field"><span>Name</span><input name="docName" required maxlength="200"></label>` +
    `<label class="field"><span>Text</span><textarea name="docText" rows="5" required></textarea></label></fieldset>`;
}

/* ---- One test: setup ---- */

export function connectionList(v: VersionView, side: string): string {
  const mark: Record<JudgeConnection["state"], string> = { mock: "◇ Mock", ready: "✓ Key set", missing: "✗ Not connected", none: "· No key needed" };
  const rows = v.judges.map((j) => `<li><span class="vs conn-${j.state}">${mark[j.state]}</span> <code>${escapeHtml(j.type)}${j.provider ? ` ${escapeHtml(j.provider)}` : ""}${j.model ? `/${escapeHtml(j.model)}` : ""}</code> <span class="muted">${escapeHtml(j.where)} — ${escapeHtml(j.note)}</span></li>`).join("");
  return `<div><div class="sh">${escapeHtml(side)} judges</div><ul class="plain">${rows || "<li class=\"muted\">no judge</li>"}</ul></div>`;
}

export function changeItem(c: RubricChange): string {
  const layer: Record<RubricChange["layer"], string> = { structure: "Criteria", judgment: "What the judge reads", policy: "How answers are scored", binding: "Who judges" };
  const pair = c.before !== undefined || c.after !== undefined
    ? `<div class="ba"><div><span class="sh">before</span><div class="bav">${escapeHtml(c.before ?? "—")}</div></div><div><span class="sh">after</span><div class="bav">${escapeHtml(c.after ?? "—")}</div></div></div>` : "";
  return `<li><span class="chip layer-${c.layer}">${layer[c.layer]}</span> ${escapeHtml(c.summary)}${pair}</li>`;
}

/** A run of removed lines beside the run of added lines that replaced it, padded where one side is shorter. */
export function changedRows(removed: string[], added: string[]): string {
  const cell = (cls: string, text: string | undefined) => (text === undefined ? '<td class="void">&nbsp;</td>' : `<td class="${cls}">${escapeHtml(text) || "&nbsp;"}</td>`);
  return Array.from({ length: Math.max(removed.length, added.length) }, (_, k) => `<tr>${cell("del", removed[k])}${cell("add", added[k])}</tr>`).join("");
}

/** Both rubric texts in two columns: removed lines only on the left, added lines only on the right. */
export function sideBySide(baseYaml: string, headYaml: string): string {
  const rows = foldRows(lineDiff(baseYaml, headYaml), 2);
  const out: string[] = [];
  for (let i = 0; i < rows.length;) {
    const [kind, line] = rows[i]!;
    const text = escapeHtml(line) || "&nbsp;";
    if (kind === "…" || kind === "=") {
      out.push(kind === "=" ? `<tr><td>${text}</td><td>${text}</td></tr>` : `<tr><td class="fold" colspan="2">${text}</td></tr>`);
      i++;
      continue;
    }
    const removed: string[] = [], added: string[] = [];
    while (rows[i]?.[0] === "-") removed.push(rows[i++]![1]);
    while (rows[i]?.[0] === "+") added.push(rows[i++]![1]);
    out.push(changedRows(removed, added));
  }
  return `<div class="sbs-wrap"><table class="sbs"><thead><tr><th>Baseline</th><th>Candidate</th></tr></thead><tbody>${out.join("")}</tbody></table></div>`;
}

export function changesPanel(view: TestView): string {
  if (!view.candidate) return `<div class="empty">Pick a candidate version to see what changed.</div>`;
  const list = view.changes.length ? `<ul class="changes">${view.changes.map(changeItem).join("")}</ul>` : `<p class="muted">The two versions do not differ in anything a judge reads or a score depends on.</p>`;
  return `${list}<p class="muted">This list is computed from the two documents: it says <em>what</em> differs, not what the difference means. The stated intent above is the author's.</p>` +
    `<details class="fold"><summary>Both versions line by line</summary>${sideBySide(view.baseline.yaml, view.candidate.yaml)}</details>`;
}

export function criteriaOf(view: TestView): CriterionOption[] {
  const all = [...(view.candidate?.criteria ?? []), ...view.baseline.criteria];
  return all.filter((c, i) => all.findIndex((x) => x.id === c.id) === i);
}

export function optionTag(value: string, label: string, chosen: unknown): string {
  return `<option value="${escapeHtml(value)}"${value === String(chosen ?? "") ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

/** The inputs an expectation of `type` takes, beyond its target. */
export function expectationParams(type: string, e: Record<string, unknown>, fields: string[]): string {
  const number = (field: string, label: string, placeholder: string) => `<label>${label} <input type="number" step="any" data-f="${field}" value="${escapeHtml(e[field] ?? "")}" placeholder="${placeholder}"></label>`;
  const typed = Array.isArray(e.fields) ? e.fields.join(", ") : e.fields ?? "";
  const params: Record<string, string> = {
    hold: number("tolerance", "allowed ±", "0"), not_lower: number("tolerance", "allowed drop", "0"), not_higher: number("tolerance", "allowed rise", "0"),
    increase: number("by", "by at least", "any"), decrease: number("by", "by at least", "any"),
    range: number("min", "from", "") + number("max", "to", ""),
    state: `<label>state <select data-f="state">${optionTag("scored", "scored", e.state)}${optionTag("needs_info", "needs information", e.state)}${optionTag("abstained", "abstained", e.state)}</select></label>`,
    asks_for: `<label>fields <input data-f="fields" value="${escapeHtml(typed)}" placeholder="${escapeHtml(fields.join(", ") || "field_id, …")}"></label>` +
      (fields.length ? `<small>declared by the rubric: ${escapeHtml(fields.join(", "))}</small>` : ""),
  };
  return params[type] ?? "";
}

export function expectationRow(caseId: string, i: number, e: Record<string, unknown>, criteria: CriterionOption[]): string {
  const types: Array<[string, string]> = [["hold", "score holds"], ["increase", "score rises"], ["decrease", "score drops"], ["not_lower", "score does not drop"], ["not_higher", "score does not rise"], ["range", "score is within"], ["state", "judgment state is"], ["asks_for", "asks for information"]];
  const type = String(e.type ?? "hold");
  const targets = (type === "asks_for" ? "" : optionTag("", "the total", e.criterion)) + criteria.map((c) => optionTag(c.id, `${c.name} (${c.id}, ${c.range[0]}–${c.range[1]})`, e.criterion)).join("");
  const fields = criteria.find((c) => c.id === e.criterion)?.fields ?? [];
  return `<div class="exp" data-case="${escapeHtml(caseId)}" data-i="${i}"><label>Expect <select data-f="type">${types.map(([v, l]) => optionTag(v, l, type)).join("")}</select></label>` +
    `<label>of <select data-f="criterion">${targets}</select></label>${expectationParams(type, e, fields)}<button class="btn small" type="button" data-act="remove-exp" aria-label="Remove this expectation">Remove</button></div>`;
}

export function expectationEditor(view: TestView, draft: Draft, dirty: boolean): string {
  const criteria = criteriaOf(view);
  const revision = view.test.revisions[view.test.revisions.length - 1]!;
  const cases = view.documents.map((d) => {
    const list = draft[d.caseId] ?? [];
    const rows = list.map((e, i) => expectationRow(d.caseId, i, e, criteria)).join("") || `<div class="muted none">No expectation: this document will be reported as not verified, never as met.</div>`;
    return `<fieldset class="ecase"><legend>${escapeHtml(d.name)}</legend><details class="fold"><summary>Document text</summary><pre class="preview">${escapeHtml(d.preview)}</pre></details>` +
      `${rows}<button class="btn small" type="button" data-act="add-exp" data-case="${escapeHtml(d.caseId)}"${view.writable ? "" : " disabled"}>Add an expectation</button></fieldset>`;
  }).join("");
  const save = view.writable ? `<div class="actions"><input id="rev-note" placeholder="Note for this revision (optional)" maxlength="500"><button class="btn primary" type="button" data-act="save-exp"${dirty ? "" : " disabled"}>Save as revision ${revision.revision + 1}</button>` +
    `<span class="muted" role="status">${dirty ? "Unsaved changes." : `Revision ${revision.revision}, saved ${escapeHtml(when(revision.createdAt))}.`}</span></div>` : "";
  return `<p class="muted">Defaults: no tolerance; a rise or drop means any amount above 0 unless you give a minimum; scores are compared as stored, before any rounding for display. ` +
    `A change is measured from the baseline <code>${escapeHtml(revision.baselineVersionId)}</code>, whichever candidate is run.</p><div id="editor">${cases}</div>${save}`;
}

export function trialRow(t: TrialSummary): string {
  const origin = t.origin.kind === "new" ? "" : ` · ${escapeHtml(t.origin.kind)} of ${escapeHtml(t.origin.of.slice(0, 14))}`;
  const p = t.progress;
  return `<li><a href="/change-tests?trial=${escapeHtml(t.id)}">${escapeHtml(when(t.createdAt))}</a> · candidate <code>${escapeHtml(t.candidateVersionId.slice(0, 11))}</code> · ${escapeHtml(trialStatusText(t))}${origin}` +
    ` · ${p.done}/${p.total} evaluations${p.reused ? ` (${p.reused} reused)` : ""}${p.failed ? `, ${p.failed} failed` : ""} · revision ${t.revision} · ${escapeHtml(metLine(t))}</li>`;
}

/** How many evaluations a trial makes, with the arithmetic shown: documents × versions × runs, less what is shown again. */
export function evaluationSum(view: TestView, again: boolean): string {
  const e = view.estimate!;
  const all = e.documents * 2;
  const head = `${e.documents} document${e.documents === 1 ? "" : "s"} × 2 versions × 1 run = ${all} evaluations`;
  if (again || !e.reused) return `${head}, <b>${again ? all : e.evaluations} new</b>`;
  return `${head}; ${e.reused} stored result${e.reused === 1 ? " is" : "s are"} shown again, so <b>${e.evaluations} new</b>`;
}

export function runPanel(view: TestView, dirty: boolean, again: boolean): string {
  if (!view.candidate) return `<div class="empty">Pick a candidate version first.</div>`;
  const blocked = [view.baseline, view.candidate].flatMap((v) => v.judges).filter((j) => j.state === "missing");
  const warn = blocked.length ? `<div class="banner warn">Not connected: ${escapeHtml(blocked.map((j) => j.note).join("; "))}. Those evaluations will fail and be reported as failed, not as scores.</div>` : "";
  const revision = view.test.revisions[view.test.revisions.length - 1]!;
  const none = Object.values(revision.cases).every((l) => !l.length) ? `<div class="banner">No expectations are saved yet: a trial would report every document as not verified.</div>` : "";
  const unsaved = dirty ? '<span class="muted">Save the expectations first: a trial is checked against a saved revision.</span>' : "";
  const run = view.writable
    ? `<div class="actions"><button class="btn primary" type="button" data-act="run"${dirty ? " disabled" : ""}>Run trial</button><label class="check"><input type="checkbox" id="again"${again ? " checked" : ""}> evaluate the baseline again instead of showing stored results</label>${unsaved}</div>` : "";
  return `<div class="conn">${connectionList(view.baseline, "Baseline")}${connectionList(view.candidate, "Candidate")}</div>${warn}${none}` +
    `<p>${evaluationSum(view, again)}. <span class="muted">No cost estimate: Verdict has no price data it can stand behind. One run shows one outcome, not how much the outcome varies.</span></p>${run}`;
}

export function scopeNote(): string {
  return `<details class="fold scope"><summary>What this test shows, and what it does not</summary><ul>` +
    `<li><b>Should hold:</b> shows whether documents the change should not touch kept their result. It does not show that a result holds when the document is reworded or reordered.</li>` +
    `<li><b>Should change:</b> shows whether documents the change is aimed at moved the intended way. It does not show how the rubric reacts when a fact in a document changes.</li>` +
    `<li><b>Should ask:</b> shows whether existing documents that lack a fact are left open with a question. It does not show that the rubric asks only when the fact is really needed.</li>` +
    `</ul><p class="muted">Those three need the document varied while the rubric stays fixed; they are not part of this release.</p></details>`;
}

export function testScreen(view: TestView, draft: Draft, ui: { dirty: boolean; again: boolean }): string {
  const t = view.test;
  const pick = (options: VersionOption[], chosen?: string) => options.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === chosen ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  const head = `<nav class="crumb"><a href="/change-tests">Change tests</a> / ${escapeHtml(t.name)}</nav><div class="title"><h1>${escapeHtml(t.name)}</h1>${demoBadge(!!t.demo)}</div>` +
    (t.demo ? `<div class="banner demo">Demo: the documents are invented and the judge is a mock that answers from a script. Nothing here is a model's judgement.</div>` : "") +
    `<div class="panel pad"><div class="sh">Stated intent — written by the author; no judge and no check reads it</div><p class="intent">${escapeHtml(t.intent || "(none written)")}</p>${scopeNote()}</div>`;
  const versions = `<section class="panel pad"><h2>1 · Versions and documents</h2><div class="two"><div><div class="sh">Baseline</div><code>${escapeHtml(view.baseline.id)}</code><div>${escapeHtml(view.baseline.name)} · v${escapeHtml(view.baseline.version)}</div></div>` +
    `<label class="field"><span class="sh">Candidate</span><select id="candidate">${pick(view.versions, view.candidate?.id)}</select></label></div>` +
    `<p class="muted">Documents: ${escapeHtml(view.dataset.label)} <code>${escapeHtml(view.dataset.id)}</code>. Both versions read exactly this set.</p></section>`;
  const trials = view.trials.length ? `<ul class="plain trials">${view.trials.map(trialRow).join("")}</ul>` : `<div class="empty">No trial yet. Run one above.</div>`;
  const open = t.followUps.filter((f) => !f.resolvedAt);
  const follow = open.length ? `<section class="panel pad"><h2>To follow up</h2><ul class="plain">${open.map((f) => `<li><a href="/change-tests?trial=${escapeHtml(f.trialId)}&case=${encodeURIComponent(f.caseId)}">${escapeHtml(f.caseId)}</a>${f.note ? ` — ${escapeHtml(f.note)}` : ""} <span class="muted">${escapeHtml(when(f.createdAt))}</span></li>`).join("")}</ul></section>` : "";
  const history = `<details class="fold"><summary>Revisions and history (${t.revisions.length})</summary><ul class="plain">${t.history.map((h) => `<li>${escapeHtml(when(h.at))} · ${escapeHtml(h.action.replace(/_/g, " "))}${h.detail ? ` — ${escapeHtml(h.detail)}` : ""}</li>`).join("")}</ul></details>`;
  return `${head}${versions}<section class="panel pad"><h2>2 · What changed in the rubric</h2>${changesPanel(view)}</section>` +
    `<section class="panel pad"><h2>3 · What you expect of each document</h2>${expectationEditor(view, draft, ui.dirty)}</section>` +
    `<section class="panel pad"><h2>4 · Run</h2>${runPanel(view, ui.dirty, ui.again)}</section>` +
    `<section class="panel pad"><h2>Trials</h2>${trials}${history}</section>${follow}`;
}

/** Reads the editor back into a draft: only what is filled in, numbers as numbers, fields as a list. */
export function readDraft(root: ParentNode, caseIds: string[]): Draft {
  const draft: Draft = Object.fromEntries(caseIds.map((id) => [id, []]));
  root.querySelectorAll<HTMLElement>(".exp").forEach((row) => {
    const e: Record<string, unknown> = {};
    row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-f]").forEach((input) => {
      const field = input.dataset.f!, value = input.value.trim();
      if (value === "") return;
      if (field === "fields") e.fields = value.split(",").map((s) => s.trim()).filter(Boolean);
      else e[field] = input instanceof HTMLInputElement && input.type === "number" ? Number(value) : value;
    });
    (draft[row.dataset.case!] ??= []).push(e);
  });
  return draft;
}

/** The saved expectations of a revision as an editable draft (ids dropped: a new revision assigns its own). */
export function draftOf(view: TestView): Draft {
  const revision = view.test.revisions[view.test.revisions.length - 1]!;
  return Object.fromEntries(view.documents.map((d) => [d.caseId, (revision.cases[d.caseId] ?? []).map(({ id: _id, ...rest }) => ({ ...rest }))]));
}

export const CHANGE_SETUP_FUNCTIONS = [num, signed, when, statusChip, stateText, trialStatusText, metLine, demoBadge, amountText, expectationText, testCard, indexScreen, selectField, newTestScreen, documentFields, connectionList, changeItem,
  changedRows, sideBySide, changesPanel, criteriaOf, optionTag, expectationParams, expectationRow, expectationEditor, trialRow, evaluationSum, runPanel, scopeNote, testScreen, readDraft, draftOf];
