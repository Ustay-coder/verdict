/**
 * Browser code of the `verdict watch` page. Each function is shipped to the page with `toString()` (see page.ts), so
 * these functions may use only each other, their parameters and browser globals: no imports at runtime and no
 * module-level values. Type imports are erased by the compiler, which keeps the page code type-checked.
 * The string builders are pure and unit-tested; `render`, `animateRows` and `start` need a DOM.
 */
import type { WatchEntry, WatchState } from "./state.js";

type DiffRow = ["=" | "+" | "-", string];

export function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(value ?? "").replace(/[&<>"]/g, (c) => entities[c] ?? c);
}
export function percent(n: number | undefined): string { return n == null ? "—" : `${Math.round(n * 100)}%`; }
export function oneDecimal(n: number | undefined): string { return n == null ? "—" : (Math.round(n * 10) / 10).toString(); }

/** Joins a score history with the last value in bold: "40 → 55 → <b>70</b>". */
export function historyLine(values: Array<number | undefined>): string {
  return values.map((v, i) => (i === values.length - 1 ? `<b>${oneDecimal(v)}</b>` : oneDecimal(v))).join(" → ");
}

/** Line diff (longest common subsequence) of two texts: kept "=", added "+" and removed "-" lines, in order. */
export function lineDiff(previous: string, current: string): DiffRow[] {
  const a = previous.split("\n"), b = current.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push(["=", b[j]!]); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) rows.push(["-", a[i++]!]);
    else rows.push(["+", b[j++]!]);
  }
  while (i < a.length) rows.push(["-", a[i++]!]);
  while (j < b.length) rows.push(["+", b[j++]!]);
  return rows;
}

/** "2 lines added, 1 removed since the previous evaluation", or why there is nothing to compare. */
export function changeNote(hasPrevious: boolean, hasPreviousDoc: boolean, rows: DiffRow[]): string {
  if (!hasPrevious) return "first evaluation";
  if (!hasPreviousDoc) return "new in this evaluation";
  const added = rows.filter((r) => r[0] === "+" && r[1].trim()).length;
  const removed = rows.filter((r) => r[0] === "-" && r[1].trim()).length;
  if (!added && !removed) return "unchanged since the previous evaluation";
  const parts = [added ? `${added} line${added > 1 ? "s" : ""} added` : "", removed ? `${removed} removed` : ""];
  return `${parts.filter(Boolean).join(", ")} since the previous evaluation`;
}

// Blank removed lines are hidden; blank added lines are not highlighted.
export function lineClass(kind: DiffRow[0], line: string): string {
  if (kind === "+" && line.trim()) return "chg";
  if (kind === "-") return line.trim() ? "del" : "gone";
  return "";
}

/** The evaluated text, with lines changed since the previous evaluation of the same rubric marked. */
export function documentPanels(entry: WatchEntry, previous?: WatchEntry): string {
  if (!entry.evidence.length) return '<div class="panel doc"><div class="hd">No text evidence</div></div>';
  return entry.evidence.map((doc) => {
    const previousDoc = previous?.evidence.find((d) => d.label === doc.label);
    const rows: DiffRow[] = previousDoc ? lineDiff(previousDoc.text, doc.text) : doc.text.split("\n").map((line) => ["=", line]);
    const lines = rows.map(([kind, line]) => `<div class="${lineClass(kind, line)}">${escapeHtml(line) || "&nbsp;"}</div>`).join("");
    return `<div class="panel doc" style="margin-bottom:16px"><div class="hd"><b>${escapeHtml(doc.label)}</b><span>${changeNote(!!previous, !!previousDoc, rows)}</span></div><pre>${lines}</pre></div>`;
  }).join("");
}

export function criterionRows(entry: WatchEntry): string {
  return entry.criteria.map((c) => {
    const note = c.gateFailed ? `<div class="why"><b>Gate:</b> ${escapeHtml(c.gateFailed)}</div>` : c.rationale ? `<div class="why">${escapeHtml(c.rationale)}</div>` : "";
    return `<div class="crit${c.gateFailed ? " bad" : ""}"><div class="row"><span class="n">${escapeHtml(c.name)}</span><span class="v">${escapeHtml(c.choice ?? "")} ${percent(c.normalized)}</span></div>` +
      `<div class="bar"><i style="width:${Math.round((c.normalized ?? 0) * 100)}%"></i></div>${note}</div>`;
  }).join("");
}

export function verdictPills(entry: WatchEntry): string {
  const grade = entry.grade ? `<span class="pill grade">${escapeHtml(entry.grade)}</span>` : "";
  const passed = entry.passed == null ? "" : entry.passed ? '<span class="pill pass">PASS</span>' : '<span class="pill fail">FAIL</span>';
  return `${grade}${passed}<span class="chip">${escapeHtml(entry.status)}</span>`;
}

/** One evaluation: text on the left; score, gates, history and criteria on the right. */
export function singleView(state: WatchState): string {
  const entry = state.entries[0]!;
  const range = entry.range ? `<small> / ${entry.range[1]}</small>` : "";
  const history = state.history.length > 1 ? `<div class="hist">History: ${historyLine(state.history.map((h) => h.score))}</div>` : "";
  const gates = entry.gatesFailed.map((g) => `<div class="gate">${escapeHtml(g)}</div>`).join("");
  return `<div class="title"><h1>${escapeHtml(state.rubric?.name)}</h1><span class="chip">v${escapeHtml(state.rubric?.version)}</span><span class="chip">${escapeHtml(entry.name)}</span></div>` +
    `<div class="grid"><div>${documentPanels(entry, state.previous)}</div>` +
    `<div class="panel"><div class="score"><div class="big">${oneDecimal(entry.score)}${range}</div><div>${verdictPills(entry)}</div>${gates}${history}</div>${criterionRows(entry)}</div></div>`;
}

export function rankCell(entry: WatchEntry, rank: number): string {
  const prev = entry.prevRank;
  const delta = !prev || prev === rank ? "" : prev > rank ? `<span class="delta up">▲${prev - rank}</span>` : `<span class="delta down">▼${rank - prev}</span>`;
  return `<div class="rank">${rank}${delta}</div>`;
}

export function miniBars(entry: WatchEntry): string {
  const shown = entry.criteria.filter((c) => c.weight > 0 || c.gateFailed).slice(0, 6);
  return shown.map((c) => `<div><span>${escapeHtml(c.name)}</span><span class="bar"><i style="width:${Math.round((c.normalized ?? 0) * 100)}%"></i></span><span>${percent(c.normalized)}</span></div>`).join("");
}

export function leaderboardRow(entry: WatchEntry, index: number): string {
  const rounds = entry.rounds && entry.rounds.length > 1 ? `<div class="lhist">${historyLine(entry.rounds)}</div>` : "";
  const preview = escapeHtml((entry.evidence[0]?.text ?? "").trim());
  const scoreNote = escapeHtml(entry.grade ?? "") + (entry.gatesFailed.length ? " · gate" : "");
  return `<div class="lrow${index === 0 ? " first" : ""}" data-k="${escapeHtml(entry.name)}">${rankCell(entry, index + 1)}` +
    `<div><div class="lname">${escapeHtml(entry.name)}</div>${rounds}<div class="prev">${preview}</div></div>` +
    `<div class="mini">${miniBars(entry)}</div><div class="lscore" data-s="${entry.score ?? ""}">${oneDecimal(entry.score)}<small>${scoreNote}</small></div></div>`;
}

/** A batch: subjects ranked best first, with their per-round history and rank change. */
export function leaderboardView(state: WatchState): string {
  const agg = state.aggregation;
  const method = agg?.method === "formula" && agg.formula ? `formula: ${agg.formula}` : agg?.method ?? "";
  const round = (state.round ?? 0) > 1 ? `<span class="chip">round ${state.round}</span>` : "";
  return `<div class="title"><h1>${escapeHtml(state.rubric?.name)}</h1>${round}<span class="chip">${state.entries.length} subjects</span><span class="chip">aggregation: ${escapeHtml(method)}</span></div>` +
    `<div class="panel board">${state.entries.map(leaderboardRow).join("")}</div>`;
}

export function statusText(state: WatchState): string {
  if (state.running) return `evaluating${state.running > 1 ? ` ${state.running} subjects` : ""}…`;
  return state.updatedAt ? `updated ${new Date(state.updatedAt).toLocaleTimeString()}` : "waiting for evaluations";
}

// Rows that changed rank slide from their old position (FLIP); a row whose score changed flashes once.
export function animateRows(app: HTMLElement, topsBefore: Map<string, number>, scoresShown: Map<string, string>): void {
  app.querySelectorAll<HTMLElement>(".lrow").forEach((row) => {
    const key = row.dataset.k ?? "", score = row.querySelector<HTMLElement>(".lscore")?.dataset.s ?? "";
    if (scoresShown.has(key) && scoresShown.get(key) !== score) row.classList.add("flash");
    scoresShown.set(key, score);
    const before = topsBefore.get(key), now = row.getBoundingClientRect().top;
    if (before == null || before === now) return;
    row.style.transition = "none";
    row.style.transform = `translateY(${before - now}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { row.style.transition = ""; row.style.transform = ""; }));
  });
}

export function render(state: WatchState, scoresShown: Map<string, string>): void {
  const app = document.querySelector<HTMLElement>("#app")!;
  const topsBefore = new Map(Array.from(app.querySelectorAll<HTMLElement>(".lrow")).map((row) => [row.dataset.k ?? "", row.getBoundingClientRect().top] as const));
  app.innerHTML = state.view === "empty" ? '<div class="empty">No evaluations yet. Run one and it shows up here.</div>' : state.view === "single" ? singleView(state) : leaderboardView(state);
  animateRows(app, topsBefore, scoresShown);
  document.querySelector("#upd")!.textContent = statusText(state);
}

/** Polls the state and redraws when it changes; a failed poll is shown in the header and retried on the next tick. */
export function start(pollMs: number): void {
  const scoresShown = new Map<string, string>();
  let last = "";
  const refresh = async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      if (body !== last) { last = body; render(JSON.parse(body) as WatchState, scoresShown); }
    } catch (error) {
      document.querySelector("#upd")!.textContent = `cannot reach verdict watch (${error instanceof Error ? error.message : String(error)}), retrying`;
    }
  };
  // Exposed so a recorder or a test can update the page on demand.
  (window as Window & { verdictWatchRefresh?: () => Promise<void> }).verdictWatchRefresh = refresh;
  const tick = () => { void refresh().finally(() => setTimeout(tick, pollMs)); };
  tick();
}

/** Every function the page needs, in an order where each is defined before `start` runs. */
export const CLIENT_FUNCTIONS = [escapeHtml, percent, oneDecimal, historyLine, lineDiff, changeNote, lineClass, documentPanels, criterionRows,
  verdictPills, singleView, rankCell, miniBars, leaderboardRow, leaderboardView, statusText, animateRows, render, start];
