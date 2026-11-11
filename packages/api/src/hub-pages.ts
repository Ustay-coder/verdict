/**
 * Server-rendered hub pages (docs/design/hub.md §16.3). Plain HTML and inline CSS, no scripts: every string shown was
 * written by an author and is escaped. Pages offer copyable `verdict pull` / `verdict fork` commands instead of links
 * that open a local server (H4).
 */
import { questionAgreement, rubricToYaml, type Publication, type PublicListing, type PublicPublication, type PublicRunSummary, type PublicVersionEntry } from "@verdict-ai/core";

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--bg:#fff;--card:#f5f5f7;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--bg:#111;--card:#1c1c1e;--accent:#6cb4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}h1{font-size:26px;margin:8px 0}h2{font-size:18px;margin:28px 0 8px}
.muted{color:var(--muted)}.meta span{margin-right:12px}.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:8px 0}
pre,code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;word-break:break-word;margin:0}pre.text{font:inherit}
code.cmd{display:block;user-select:all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
form{display:flex;flex-wrap:wrap;gap:8px}input,select,button{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input[name=q]{flex:1 1 240px}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;margin-right:4px}
`;

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const day = (iso: string) => esc(iso.slice(0, 10));
const cardUrl = (ref: string, versionId?: string) => `/hub/${ref.split("/").map(encodeURIComponent).join("/")}${versionId ? `?version=${encodeURIComponent(versionId)}` : ""}`;
const pct = (agreed: number, n: number) => (n ? `${Math.round((agreed / n) * 100)}%` : "–");

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Verdict hub</title><style>${STYLE}</style></head><body><main>
<p class="muted"><a href="/hub">Verdict hub</a> — single-question judgment cards with their test cases</p>
${body}</main></body></html>`;
}

export interface SearchView { query: { q?: string; domain?: string; locale?: string; type?: string }; results: PublicListing[] }

export function searchPage({ query, results }: SearchView): string {
  const type = (value: string, label: string) => `<option value="${value}"${query.type === value ? " selected" : ""}>${label}</option>`;
  const form = `<form method="get" action="/hub">
<input name="q" placeholder="Search titles, authors, slugs, domains" value="${esc(query.q)}">
<input name="domain" placeholder="domain" value="${esc(query.domain)}" size="14"><input name="locale" placeholder="locale" value="${esc(query.locale)}" size="8">
<select name="type">${type("", "any answer")}${type("noul", "yes / no")}${type("score", "score")}${type("choice", "choice")}</select><button>Search</button></form>`;
  const list = results.length ? results.map(resultItem).join("") : `<p class="muted">No published cards match.</p>`;
  return layout("Search", `<h1>Judgment cards</h1>${form}${list}`);
}

function resultItem(r: PublicListing): string {
  const tags = [r.judgmentType, r.domain, r.locale, r.license].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const fork = r.parent?.public ? ` · fork of <a href="${cardUrl(r.parent.ref, r.parent.versionId)}">${esc(r.parent.ref)}</a>` : r.parent ? " · fork of an unpublished version" : "";
  return `<div class="box"><a href="${cardUrl(r.ref)}"><strong>${esc(r.title)}</strong></a> <span class="muted">${esc(r.ref)}</span><br>
${r.description ? `<span>${esc(r.description)}</span><br>` : ""}${tags} <span class="muted">${r.cases} public case(s) · ${r.runs} reported run(s) · ${day(r.latest.createdAt)}${fork}</span></div>`;
}

export interface CardView { origin: string; publication: PublicPublication; versions: PublicVersionEntry[] }

export function cardPage({ origin, publication: p, versions }: CardView): string {
  const header = `<h1>${esc(p.title)}</h1>
<p class="meta muted"><span>${esc(p.ref)}</span><span><code>${esc(p.version.id)}</code></span><span>${esc(p.judgmentType)}</span><span>${esc(p.license)}</span>${p.domain ? `<span>${esc(p.domain)}</span>` : ""}${p.locale ? `<span>${esc(p.locale)}</span>` : ""}<span>published ${day(p.createdAt)}</span></p>
${p.description ? `<p>${esc(p.description)}</p>` : ""}`;
  return layout(p.title, [header, lineage(p), useIt(origin, p), question(p), runs(p), cases(p), provenance(p), history(p.ref, p.version.id, versions), rubricSource(p)].join(""));
}

function lineage(p: PublicPublication): string {
  if (!p.parent) return "";
  const from = p.parent.public ? `Forked from <a href="${cardUrl(p.parent.ref, p.parent.versionId)}">${esc(p.parent.ref)}</a> at <code>${esc(p.parent.versionId)}</code>.` : "Derived from a version that is not public.";
  const kinds = p.version.changeKinds?.length ? ` Changed: ${p.version.changeKinds.map((k) => `<span class="tag">${esc(k)}</span>`).join("")}` : "";
  return `<div class="box">${from}${kinds}${p.version.forkNote ? `<br><span class="muted">Fork note:</span> ${esc(p.version.forkNote)}` : ""}
<br><span class="muted">Results of the parent are not results of this version; each version shows only its own runs.</span></div>`;
}

function useIt(origin: string, p: PublicPublication): string {
  const ref = `hub:${p.ref}@${p.version.id}`, hub = `--hub ${origin}`;
  return `<h2>Use it</h2><div class="box">Copy this version exactly (same id when you freeze it), with its public cases:
<code class="cmd">verdict pull ${esc(ref)} ${esc(hub)}</code>Or start your own version from it; the parent is recorded in verdict.lock:
<code class="cmd">verdict fork ${esc(ref)} --to ${esc(p.slug)}.yaml ${esc(hub)}</code></div>`;
}

function question(p: PublicPublication): string {
  const c = p.version.rubric.criteria[0]!;
  const answers = c.choices ? Object.entries(c.choices) : c.levels ? c.levels.map((l) => [l.label ?? String(l.value), l.description] as const) : Object.entries(c.anchors ?? {});
  const list = answers.length ? `<table>${answers.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>` : "";
  const threshold = c.threshold !== undefined ? `<p class="muted">Answers yes when the model's probability of yes is at least ${esc(c.threshold)}.</p>` : "";
  return `<h2>The question</h2><div class="box"><strong>${esc(c.name)}</strong>${c.description ? `<pre class="text">${esc(c.description)}</pre>` : ""}${list}${threshold}</div>`;
}

function runs(p: PublicPublication): string {
  const list = p.runs;
  if (!list.length) return `<h2>Reported runs</h2><p class="muted">The author attached no runs.</p>`;
  return `<h2>Reported runs</h2>${list.map((r) => runBox(p, r)).join("")}`;
}

function runBox(p: PublicPublication, r: PublicRunSummary): string {
  const q = questionAgreement(p, r);
  const models = r.fingerprint.models.map((m) => `${m.provider}${m.resolved ? ` ${m.resolved}` : m.requested ? ` ${m.requested} (requested)` : ""}${m.verified ? "" : " (unverified)"}`).join(", ");
  const sources = r.labelSources ? Object.entries(r.labelSources).map(([k, n]) => `${esc(k)} ${n}`).join(" · ") : "unknown";
  const criteria = Object.entries(r.agreement.criteria).map(([id, t]) => `<tr><td>${esc(id)}</td><td>${t.agreed}/${t.n} (${pct(t.agreed, t.n)})</td><td>${t.askedHuman}</td></tr>`).join("");
  return `<div class="box"><strong>${pct(q.agreed, q.n)}</strong> agreement with the labels (${q.agreed} of ${q.n} labelled case(s)${q.askedHuman ? `; ${q.askedHuman} handed to a person` : ""}) over ${r.counts.cases} case(s) · ${esc(r.status)} · ${day(r.startedAt)}
<br><span class="muted">Reported by the author, not re-run by the hub. ${r.casesPublic ? "Every case of this run is public: anyone can repeat it." : "This run includes private cases: only its numbers are shown."}</span>
<br><span class="muted">Models:</span> ${esc(models || "–")} · <span class="muted">labels:</span> ${sources}
<table><tr><th>criterion</th><th>agreed</th><th>asked a person</th></tr>${criteria}</table></div>`;
}

function cases(p: PublicPublication): string {
  if (!p.cases.length) return `<h2>Public cases</h2><p class="muted">No public cases.</p>`;
  const rows = p.cases.map((c) => `<tr><td>${esc(c.id)}</td><td><pre class="text">${esc(c.inputs.map(inputText).join("\n"))}</pre></td><td>${esc(Object.values(c.expected).join(", "))}</td><td>${esc(c.labelSource ?? "unknown")}${c.split ? ` · ${esc(c.split)}` : ""}</td></tr>`).join("");
  return `<h2>Public cases (${p.cases.length})</h2><table><tr><th>case</th><th>input</th><th>expected</th><th>label</th></tr>${rows}</table>`;
}

function inputText(input: PublicPublication["cases"][number]["inputs"][number]): string {
  const raw = input as { type: string; text?: string; data?: unknown; url?: string };
  const text = raw.type === "text" ? raw.text ?? "" : raw.type === "url" ? raw.url ?? "" : JSON.stringify(raw.data ?? raw);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function provenance(p: PublicPublication): string {
  if (!p.sources.length && !p.note) return "";
  return `<h2>Sources</h2><div class="box">${p.sources.map((s) => `<div>${esc(s)}</div>`).join("")}${p.note ? `<p>${esc(p.note)}</p>` : ""}</div>`;
}

function history(ref: string, current: string, versions: PublicVersionEntry[]): string {
  const rows = versions.map((v) => {
    const label = v.versionId === current ? `<strong>${esc(v.versionId)}</strong>` : v.withdrawnAt ? esc(v.versionId) : `<a href="${cardUrl(ref, v.versionId)}">${esc(v.versionId)}</a>`;
    return `<tr><td><code>${label}</code></td><td>${day(v.createdAt)}</td><td>${v.withdrawnAt ? `withdrawn ${day(v.withdrawnAt)}` : esc(v.changeKinds?.join(", ") ?? "")}</td></tr>`;
  }).join("");
  return `<h2>Versions</h2><table>${rows}</table>`;
}

function rubricSource(p: PublicPublication): string {
  return `<h2>Rubric</h2><details class="box"><summary>YAML of ${esc(p.version.id)}</summary><pre>${esc(rubricToYaml(p.version.rubric))}</pre></details>`;
}

export function goneCardPage(p: Publication, message: string): string {
  return layout(p.title, `<h1>${esc(p.title)}</h1><p class="muted">${esc(p.ref)} · <code>${esc(p.version.id)}</code></p><div class="box">${esc(message)}.</div><p><a href="${cardUrl(p.ref)}">See this card's other versions</a></p>`);
}

export function missingPage(message: string): string {
  return layout("Not found", `<h1>Not found</h1><p>${esc(message)}.</p>`);
}
