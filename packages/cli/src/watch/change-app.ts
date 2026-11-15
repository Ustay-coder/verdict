/**
 * The controller of the change-test screens: reads the URL, loads the view it names and wires the page's controls.
 * Shipped with `toString()` (see change-client.ts for the rules), so everything it needs travels in one `ChangeApp`
 * object. The chart and the table share one selection: choosing a document in either opens the same detail.
 * Results are whatever the server stored; a reload shows the same screen again.
 */
import { draftOf, indexScreen, newTestScreen, readDraft, testScreen, documentFields, type Draft } from "./change-client.js";
import { trialScreen, type ResultUi } from "./change-results.js";
import type { ChangeIndexView, TestView, TrialView } from "./change-state.js";
import { escapeHtml } from "./client.js";

export interface ChangeApp {
  token: string; pollMs: number; root: HTMLElement; status: HTMLElement;
  ui: ResultUi; draft: Draft; dirty: boolean; again: boolean;
  /** The test and revision the draft was loaded from, so a reload of the same test keeps unsaved edits. */
  draftKey: string; picked: Record<string, string>;
  index?: ChangeIndexView; test?: TestView; trial?: TrialView;
  timer?: ReturnType<typeof setTimeout>; busy: boolean;
  /** What the last drawn screen was drawn from: a poll that brings nothing new leaves the page, and a click on it, alone. */
  drawn?: string;
}

export async function changeApi(app: ChangeApp, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json", "x-verdict-watch": app.token }, body: JSON.stringify(body) };
  const response = await fetch(`/api/change/${path}`, init);
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `${response.status} ${response.statusText}`);
  return data;
}

export function changeFail(app: ChangeApp, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  app.status.textContent = "error";
  app.root.querySelector(".alert")?.remove();
  app.root.insertAdjacentHTML("afterbegin", `<div class="banner bad alert" role="alert"><b>That did not work.</b> ${escapeHtml(message)}</div>`);
  app.root.querySelector<HTMLElement>(".alert")?.scrollIntoView({ block: "nearest" });
}

/** Redraws the current screen, keeping the keyboard focus on the same expectation field when there was one. */
export function changeRender(app: ChangeApp): void {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>(".exp");
  const keep = row && active?.dataset.f ? `.exp[data-case="${CSS.escape(row.dataset.case ?? "")}"][data-i="${row.dataset.i}"] [data-f="${active.dataset.f}"]` : active?.id ? `#${CSS.escape(active.id)}` : "";
  const query = new URLSearchParams(location.search);
  if (app.trial && query.get("trial")) app.root.innerHTML = trialScreen(app.trial, app.ui);
  else if (app.test && query.get("test")) app.root.innerHTML = testScreen(app.test, app.draft, { dirty: app.dirty, again: app.again });
  else if (app.index) app.root.innerHTML = query.get("new") ? newTestScreen(app.index, app.picked) : indexScreen(app.index);
  if (keep) app.root.querySelector<HTMLElement>(keep)?.focus();
}

export async function changeLoadTrial(app: ChangeApp, query: URLSearchParams): Promise<void> {
  const verification = query.get("verification");
  const view = await changeApi(app, `trial?id=${encodeURIComponent(query.get("trial")!)}${verification ? `&verification=${encodeURIComponent(verification)}` : ""}`) as unknown as TrialView;
  app.trial = view;
  // One criterion: show it, in its own points. Several: start from the total.
  if (!view.targets.some((t) => t.id === app.ui.target)) app.ui.target = view.targets.length === 2 ? view.targets[1]!.id : "total";
  if (query.get("case")) app.ui.selected = query.get("case")!;
  if (!view.cases.some((c) => c.caseId === app.ui.selected)) app.ui.selected = undefined;
  if (view.trial.status === "queued" || view.trial.status === "running") app.timer = setTimeout(() => void changeLoad(app), app.pollMs);
}

export async function changeLoadTest(app: ChangeApp, query: URLSearchParams): Promise<void> {
  const candidate = query.get("candidate");
  const view = await changeApi(app, `test?id=${encodeURIComponent(query.get("test")!)}${candidate ? `&candidate=${encodeURIComponent(candidate)}` : ""}`) as unknown as TestView;
  app.test = view;
  const key = `${view.test.id}#${view.test.revisions.length}`;
  if (app.draftKey !== key) { app.draft = draftOf(view); app.dirty = false; app.draftKey = key; }
}

export async function changeLoad(app: ChangeApp): Promise<void> {
  clearTimeout(app.timer);
  const query = new URLSearchParams(location.search);
  try {
    if (query.get("trial")) await changeLoadTrial(app, query);
    else if (query.get("test")) await changeLoadTest(app, query);
    else app.index = await changeApi(app, "index") as unknown as ChangeIndexView;
    const drawn = location.search + JSON.stringify(query.get("trial") ? app.trial : query.get("test") ? app.test : app.index);
    if (drawn !== app.drawn) changeRender(app);
    app.drawn = drawn;
    app.status.textContent = `loaded ${new Date().toLocaleTimeString()}`;
  } catch (error) { changeFail(app, error); }
}

export function changeGo(app: ChangeApp, query: string): void {
  history.pushState(null, "", `/change-tests${query}`);
  window.scrollTo(0, 0);
  void changeLoad(app);
}

/** Opens a document's detail from the chart or the table, and brings it into view where it sits below them. */
export function changeSelect(app: ChangeApp, caseId: string): void {
  app.ui.selected = caseId;
  const query = new URLSearchParams(location.search);
  query.set("case", caseId);
  history.replaceState(null, "", `/change-tests?${query}`);
  changeRender(app);
  const detail = app.root.querySelector<HTMLElement>("#detail");
  if (detail && window.matchMedia("(max-width: 1100px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  detail?.querySelector<HTMLElement>("h2")?.setAttribute("tabindex", "-1");
  detail?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}

export async function changeTrialAction(app: ChangeApp, act: string, button: HTMLElement): Promise<void> {
  const view = app.trial!;
  const trialId = view.trial.id, testId = view.test.id;
  if (act === "cancel") await changeApi(app, "cancel", { trialId });
  else if (act === "reverify") { await changeApi(app, "reverify", { trialId }); history.replaceState(null, "", `/change-tests?trial=${trialId}`); }
  else if (act === "retry" || act === "rerun") {
    const made = await changeApi(app, "trials", { testId, candidateVersionId: view.candidate.id, origin: { kind: act, of: trialId } });
    return changeGo(app, `?trial=${made.trialId}`);
  } else if (act === "follow") await changeApi(app, "follow-ups", { testId, trialId, caseId: button.dataset.case, note: app.root.querySelector<HTMLInputElement>("#follow-note")?.value.trim() || undefined });
  else if (act === "resolve-follow") await changeApi(app, "follow-ups", { testId, resolve: button.dataset.id });
  else if (act === "prev" || act === "next") {
    const at = view.cases.findIndex((c) => c.caseId === app.ui.selected) + (act === "next" ? 1 : -1);
    return view.cases[at] ? changeSelect(app, view.cases[at].caseId) : undefined;
  }
  await changeLoad(app);
}

export async function changeSetupAction(app: ChangeApp, act: string, button: HTMLElement): Promise<void> {
  const view = app.test;
  if (act === "demo") { await changeApi(app, "demo", {}); return changeLoad(app); }
  if (act === "more-doc") { const list = app.root.querySelector<HTMLElement>("#doc-list")!; list.insertAdjacentHTML("beforeend", documentFields(list.children.length)); return; }
  if (!view) return;
  const caseIds = view.documents.map((d) => d.caseId);
  if (act === "add-exp" || act === "remove-exp") {
    app.draft = readDraft(app.root, caseIds);
    const row = button.closest<HTMLElement>(".exp");
    if (act === "add-exp") (app.draft[button.dataset.case!] ??= []).push({ type: "hold", criterion: view.candidate?.criteria.length === 1 ? view.candidate.criteria[0]!.id : undefined });
    else app.draft[row!.dataset.case!]!.splice(Number(row!.dataset.i), 1);
    app.dirty = true;
    return changeRender(app);
  }
  if (act === "save-exp") {
    app.draft = readDraft(app.root, caseIds);
    await changeApi(app, "revisions", { testId: view.test.id, cases: app.draft, note: app.root.querySelector<HTMLInputElement>("#rev-note")?.value.trim() || undefined });
    return changeLoad(app);
  }
  if (act === "run" && view.candidate) {
    const made = await changeApi(app, "trials", { testId: view.test.id, candidateVersionId: view.candidate.id, reuseBaseline: !app.again });
    changeGo(app, `?trial=${made.trialId}`);
  }
}

export function changeClick(app: ChangeApp, event: Event): void {
  const target = event.target as HTMLElement;
  const quote = target.closest<HTMLElement>("[data-mark]");
  if (quote) {
    const mark = document.getElementById(quote.dataset.mark!);
    app.root.querySelectorAll("mark.hit").forEach((m) => m.classList.remove("hit"));
    mark?.classList.add("hit");
    mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    mark?.focus({ preventScroll: true });
    return;
  }
  const button = target.closest<HTMLElement>("[data-act]");
  if (button) {
    // One request at a time: a second click while one is in flight starts nothing.
    if (app.busy || button.hasAttribute("disabled")) return;
    app.busy = true;
    const act = button.dataset.act!;
    const work = app.trial && new URLSearchParams(location.search).get("trial") ? changeTrialAction(app, act, button) : changeSetupAction(app, act, button);
    void work.catch((error) => changeFail(app, error)).finally(() => { app.busy = false; });
    return;
  }
  const picked = target.closest<HTMLElement>(".cbar[data-case], .rowbtn[data-case], tr[data-case]");
  if (picked && !target.closest("a")) changeSelect(app, picked.dataset.case!);
}

export function changeInput(app: ChangeApp, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const query = new URLSearchParams(location.search);
  if (target.id === "target" || target.id === "sort" || target.id === "filter") { app.ui[target.id] = target.value; return changeRender(app); }
  if (target.id === "verification") { query.set("verification", target.value); return changeGo(app, `?${query}`); }
  if (target.id === "candidate") { query.set("candidate", target.value); return changeGo(app, `?${query}`); }
  if (target.id === "again") { app.again = (target as HTMLInputElement).checked; return changeRender(app); }
  if (target.closest("#editor") && app.test) {
    app.draft = readDraft(app.root, app.test.documents.map((d) => d.caseId));
    const structural = target.dataset.f === "type" || target.dataset.f === "criterion";
    if (!app.dirty || structural) { app.dirty = true; changeRender(app); }
  }
  if (target.closest("#new-test")) app.picked[target.name] = target.value;
}

export async function changeSubmit(app: ChangeApp, form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "").trim();
  if (form.id === "new-test") {
    const made = await changeApi(app, "tests", { name: text("name"), intent: text("intent"), baselineVersionId: text("baselineVersionId"), candidateVersionId: text("candidateVersionId"), datasetVersionId: text("datasetVersionId"), cases: {} });
    app.picked = {};
    return changeGo(app, `?test=${made.testId}`);
  }
  if (form.id === "add-version") app.picked.candidateVersionId = String((await changeApi(app, "versions", { rubric: text("rubric") })).versionId);
  if (form.id === "add-documents") {
    const names = data.getAll("docName").map(String), texts = data.getAll("docText").map(String);
    app.picked.datasetVersionId = String((await changeApi(app, "documents", { name: text("name") || undefined, documents: names.map((name, i) => ({ name: name.trim(), text: texts[i] ?? "" })) })).datasetVersionId);
  }
  await changeLoad(app);
}

export function startChange(token: string, pollMs: number): void {
  const app: ChangeApp = {
    token, pollMs, root: document.querySelector<HTMLElement>("#app")!, status: document.querySelector<HTMLElement>("#upd")!,
    ui: { target: "", sort: "order", filter: "" }, draft: {}, dirty: false, again: false, draftKey: "", picked: {}, busy: false,
  };
  app.root.addEventListener("click", (event) => changeClick(app, event));
  app.root.addEventListener("change", (event) => changeInput(app, event));
  // Typing counts as an edit at once, so the save button wakes up before the field is left.
  app.root.addEventListener("input", (event) => { if ((event.target as HTMLElement).closest("#editor") && !app.dirty) changeInput(app, event); });
  app.root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (app.busy) return;
    app.busy = true;
    void changeSubmit(app, event.target as HTMLFormElement).catch((error) => changeFail(app, error)).finally(() => { app.busy = false; });
  });
  window.addEventListener("popstate", () => void changeLoad(app));
  window.addEventListener("beforeunload", (event) => { if (app.dirty) event.preventDefault(); });
  void changeLoad(app);
}

export const CHANGE_APP_FUNCTIONS = [changeApi, changeFail, changeRender, changeLoadTrial, changeLoadTest, changeLoad, changeGo, changeSelect, changeTrialAction, changeSetupAction, changeClick, changeInput, changeSubmit, startChange];
