// `verdict watch`: a live local page over the evaluations in .verdict/ (or VERDICT_DATA_DIR).
//
// The page polls /api/state and shows the most recently updated evaluation:
//   - one evaluation: its score, grade, gates and criteria, the evaluated text with the lines that changed since the
//     previous evaluation of the same rubric marked, and the score history;
//   - a batch (compare / POST /v1/batches): a leaderboard of its evaluations. Re-aggregating them re-ranks the rows in
//     place, so a rank change is visible as rows moving.
import { createServer, type Server } from "node:http";
import type { Evaluation, Store } from "@verdict/core";

export interface WatchCriterion { id: string; name: string; weight: number; status: string; normalized?: number; choice?: string; gateFailed?: string; rationale?: string }
export interface WatchEntry {
  id: string; name: string; status: string; score?: number; range: [number, number] | null; grade?: string; passed?: boolean;
  gatesFailed: string[]; criteria: WatchCriterion[]; evidence: Array<{ label: string; kind: string; text: string }>; createdAt: string; updatedAt: string;
}
export interface WatchState {
  updatedAt?: string;
  view: "empty" | "single" | "leaderboard";
  rubric?: { name: string; version: string };
  aggregation?: { method: string; formula?: string };
  /** single: [current]; leaderboard: ranked best first. */
  entries: WatchEntry[];
  /** single: the previous evaluation of the same rubric (for the changed-lines view). */
  previous?: WatchEntry;
  /** single: scores of this rubric's evaluations, oldest first. */
  history: Array<{ id: string; name: string; score?: number; grade?: string }>;
  /** Evaluations still running (shown as a note; the page keeps the last finished result until they land). */
  running: number;
}

const TEXT_KINDS = new Set(["text", "file", "json", "url", "youtube"]);

function entry(ev: Evaluation): WatchEntry {
  const a = ev.aggregate;
  return {
    id: ev.id,
    name: ev.subject.name ?? ev.evidence[0]?.label ?? ev.id,
    status: ev.status,
    score: a.score, range: a.range, grade: a.grade, passed: a.passed,
    gatesFailed: a.gates.filter((g) => !g.passed).map((g) => g.message ?? `${g.criterion} below its gate`),
    criteria: ev.criteria.map((c) => ({
      id: c.criterionId, name: c.name, weight: c.weight, status: c.status, normalized: c.normalized, choice: c.choice,
      gateFailed: c.gate && !c.gate.passed ? c.gate.message ?? "gate failed" : undefined,
      rationale: c.ratings.find((r) => r.rationale)?.rationale?.slice(0, 400),
    })),
    evidence: ev.evidence.filter((e) => TEXT_KINDS.has(e.kind)).map((e) => ({ label: e.label, kind: e.kind, text: e.text.slice(0, 8000) })),
    createdAt: ev.createdAt, updatedAt: ev.updatedAt,
  };
}

const byScore = (a: WatchEntry, b: WatchEntry) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.name.localeCompare(b.name);
const rubricKey = (ev: Evaluation) => ev.rubricId ?? `${ev.rubric.name}@${ev.rubric.version}`;

/** What the page shows for a set of stored evaluations. Pure: the same function drives the live page and replays. */
export function watchState(evaluations: Evaluation[]): WatchState {
  const running = evaluations.filter((e) => e.status === "queued" || e.status === "running").length;
  const evs = evaluations.filter((e) => e.status !== "queued" && e.status !== "running").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.createdAt.localeCompare(b.createdAt));
  const latest = evs.at(-1);
  if (!latest) return { view: "empty", entries: [], history: [], running };
  const base = { running, updatedAt: latest.updatedAt, rubric: { name: latest.rubric.name, version: latest.rubric.version },
    aggregation: { method: latest.rubric.aggregation.method, formula: latest.rubric.aggregation.formula } };
  if (latest.batchId) {
    // A batch lands one evaluation at a time: keep showing the newest batch that has finished completely.
    const unfinished = new Set(evaluations.filter((e) => e.batchId && (e.status === "queued" || e.status === "running")).map((e) => e.batchId));
    const shown = [...evs].reverse().find((e) => e.batchId && !unfinished.has(e.batchId))?.batchId ?? latest.batchId;
    const batch = evs.filter((e) => e.batchId === shown);
    return { ...base, view: "leaderboard", entries: batch.map(entry).sort(byScore), history: [] };
  }
  const same = evs.filter((e) => !e.batchId && rubricKey(e) === rubricKey(latest)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const i = same.findIndex((e) => e.id === latest.id);
  return {
    ...base, view: "single", entries: [entry(latest)], previous: i > 0 ? entry(same[i - 1]!) : undefined,
    history: same.slice(0, i + 1).map((e) => ({ id: e.id, name: e.subject.name ?? e.id, score: e.aggregate.score, grade: e.aggregate.grade })),
  };
}

export function serveWatch(store: Store, opts: { port: number; host?: string; dataDir?: string }): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/state")) {
        const state = watchState(await store.listEvaluations({ limit: 500 }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return void res.end(JSON.stringify(state));
      }
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(watchPage(opts.dataDir));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server)));
}

export function watchPage(source = ".verdict"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>verdict watch</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6ea;--text:#16181d;--muted:#667085;--accent:#2f5bd3;--good:#18794e;--warn:#a15c07;--bad:#c4320a;--add:#e8f5ec;--addline:#9fd4b0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Noto Sans CJK KR",NanumGothic,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--panel);border-bottom:1px solid var(--line)}
header b{font-size:15px}header .src{color:var(--muted);font:12px ui-monospace,Menlo,monospace}header .live{margin-left:auto;color:var(--muted);font-size:12px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);margin-right:6px;vertical-align:1px}
main{padding:20px 24px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px}
.title{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}.title h1{font-size:20px;margin:0}.chip{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px;background:var(--panel)}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;align-items:start}
.doc .hd{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:8px;color:var(--muted);font-size:12px}.doc .hd b{color:var(--text)}
.doc pre{margin:0;padding:8px 0;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,D2Coding,NanumGothicCoding,monospace;white-space:pre-wrap;word-break:break-word}
.doc pre div{padding:0 14px}.doc pre .chg{background:var(--add);box-shadow:inset 3px 0 var(--addline)}
.doc pre .del{background:#fdecea;box-shadow:inset 3px 0 #f2a99d;color:#9b2c1c;text-decoration:line-through;text-decoration-color:#d9826f}.doc pre .gone{display:none}
.score{padding:16px}.big{font-size:44px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.big small{font-size:18px;color:var(--muted);font-weight:500}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;margin-right:6px}.pass{background:#e3f4ea;color:var(--good)}.fail{background:#fdeae4;color:var(--bad)}.grade{background:#eef1f6;color:#344054}
.gate{margin-top:12px;padding:10px 12px;border-radius:6px;background:#fdeae4;color:#8a2508;font-size:13px}
.hist{margin-top:12px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.hist b{color:var(--text)}
.crit{border-top:1px solid var(--line);padding:10px 16px}.crit .row{display:flex;gap:8px;align-items:baseline}.crit .n{flex:1;font-weight:550}.crit .v{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
.bar{height:6px;background:#eef1f6;border-radius:3px;margin:6px 0 4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:3px;transition:width .5s}
.crit.bad .bar i{background:var(--bad)}.crit.bad .n{color:var(--bad)}.why{color:var(--muted);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.board{position:relative}.lrow{display:grid;grid-template-columns:44px minmax(0,1fr) 220px 90px;gap:16px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel);transition:transform .7s cubic-bezier(.2,.8,.2,1)}
.lrow:last-child{border-bottom:0}.rank{font-size:22px;font-weight:650;color:var(--muted);font-variant-numeric:tabular-nums}.lrow.first .rank{color:var(--accent)}
.lname{font-weight:600}.prev{color:var(--muted);font-size:13px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}
.mini{display:grid;gap:3px}.mini div{display:grid;grid-template-columns:86px 1fr 30px;gap:6px;align-items:center;font-size:11px;color:var(--muted)}.mini .bar{margin:0;height:5px}
.lscore{text-align:right;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.lscore small{display:block;font-size:11px;color:var(--muted);font-weight:500}
.flash{animation:flash 1.2s}@keyframes flash{0%{background:#fff4d6}100%{background:var(--panel)}}
.empty{color:var(--muted);padding:60px;text-align:center}
</style></head><body>
<header><b>verdict watch</b><span class="src">${source.replace(/[<>&]/g, "")}</span><span class="live"><span class="dot"></span><span id="upd">waiting for evaluations</span></span></header>
<main id="app"><div class="empty">No evaluations yet. Run one and it shows up here.</div></main>
<script>
const $=(s)=>document.querySelector(s), esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const pct=(n)=>n==null?"—":Math.round(n*100)+"%", num=(n)=>n==null?"—":(Math.round(n*10)/10).toString();
let last="", prevRects=new Map(), prevScores=new Map();
// Line diff (LCS) against the previous evaluation's text: kept, added and removed lines.
function diff(prev,cur){ const a=prev.split("\\n"), b=cur.split("\\n"), n=a.length, m=b.length;
  const L=Array.from({length:n+1},()=>new Int32Array(m+1)); for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--) L[i][j]=a[i]===b[j]?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
  const out=[]; let i=0,j=0; while(i<n&&j<m){ if(a[i]===b[j]){out.push(["=",b[j]]);i++;j++;} else if(L[i+1][j]>=L[i][j+1]) out.push(["-",a[i++]]); else out.push(["+",b[j++]]); }
  while(i<n) out.push(["-",a[i++]]); while(j<m) out.push(["+",b[j++]]); return out; }
function crits(e){ return e.criteria.map(c=>'<div class="crit'+(c.gateFailed?' bad':'')+'"><div class="row"><span class="n">'+esc(c.name)+'</span><span class="v">'+esc(c.choice??"")+' '+pct(c.normalized)+'</span></div><div class="bar"><i style="width:'+Math.round((c.normalized??0)*100)+'%"></i></div>'+(c.gateFailed?'<div class="why"><b>Gate:</b> '+esc(c.gateFailed)+'</div>':c.rationale?'<div class="why">'+esc(c.rationale)+'</div>':'')+'</div>').join(""); }
function docs(e,prev){
  if(!e.evidence.length) return '<div class="panel doc"><div class="hd">No text evidence</div></div>';
  return e.evidence.map(doc=>{ const p=prev?.evidence.find(d=>d.label===doc.label);
    const rows=p?diff(p.text,doc.text):doc.text.split("\\n").map(l=>["=",l]);
    const add=rows.filter(r=>r[0]==="+"&&r[1].trim()).length, del=rows.filter(r=>r[0]==="-"&&r[1].trim()).length;
    const note=!prev?'first evaluation':!p?'new in this evaluation':add||del?[add?add+' line'+(add>1?'s':'')+' added':'',del?del+' removed':''].filter(Boolean).join(', ')+' since the previous evaluation':'unchanged since the previous evaluation';
    const lines=rows.map(([t,l])=>'<div class="'+(t==="+"&&l.trim()?'chg':t==="-"&&l.trim()?'del':t==="-"?'gone':'')+'">'+(esc(l)||"&nbsp;")+'</div>').join("");
    return '<div class="panel doc" style="margin-bottom:16px"><div class="hd"><b>'+esc(doc.label)+'</b><span>'+note+'</span></div><pre>'+lines+'</pre></div>'; }).join("");
}
function single(s){
  const e=s.entries[0], range=e.range?'<small> / '+e.range[1]+'</small>':"";
  return '<div class="title"><h1>'+esc(s.rubric.name)+'</h1><span class="chip">v'+esc(s.rubric.version)+'</span><span class="chip">'+esc(e.name)+'</span></div>'+
  '<div class="grid"><div>'+docs(e,s.previous)+'</div>'+
  '<div class="panel"><div class="score"><div class="big">'+num(e.score)+range+'</div><div>'+(e.grade?'<span class="pill grade">'+esc(e.grade)+'</span>':'')+(e.passed!=null?'<span class="pill '+(e.passed?'pass">PASS':'fail">FAIL')+'</span>':'')+'<span class="chip">'+esc(e.status)+'</span></div>'+
  e.gatesFailed.map(g=>'<div class="gate">'+esc(g)+'</div>').join("")+
  (s.history.length>1?'<div class="hist">History: '+s.history.map((h,i)=>i===s.history.length-1?'<b>'+num(h.score)+'</b>':num(h.score)).join(" → ")+'</div>':'')+'</div>'+crits(e)+'</div></div>';
}
function board(s){
  const agg=s.aggregation, desc=agg.method==="formula"&&agg.formula?'formula: '+agg.formula:agg.method;
  return '<div class="title"><h1>'+esc(s.rubric.name)+'</h1><span class="chip">'+s.entries.length+' subjects</span><span class="chip">aggregation: '+esc(desc)+'</span></div><div class="panel board">'+
  s.entries.map((e,i)=>'<div class="lrow'+(i===0?' first':'')+'" data-k="'+esc(e.name)+'"><div class="rank">'+(i+1)+'</div><div><div class="lname">'+esc(e.name)+'</div><div class="prev">'+esc((e.evidence[0]?.text??"").trim())+'</div></div><div class="mini">'+
  e.criteria.filter(c=>c.weight>0||c.gateFailed).slice(0,6).map(c=>'<div><span>'+esc(c.name)+'</span><span class="bar"><i style="width:'+Math.round((c.normalized??0)*100)+'%"></i></span><span>'+pct(c.normalized)+'</span></div>').join("")+
  '</div><div class="lscore" data-s="'+(e.score??"")+'">'+num(e.score)+'<small>'+esc(e.grade??"")+(e.gatesFailed.length?' · gate':'')+'</small></div></div>').join("")+'</div>';
}
function render(s){
  const app=$("#app");
  app.querySelectorAll(".lrow").forEach(r=>prevRects.set(r.dataset.k,r.getBoundingClientRect().top));
  app.innerHTML=s.view==="empty"?'<div class="empty">No evaluations yet. Run one and it shows up here.</div>':s.view==="single"?single(s):board(s);
  // Rows that moved slide from their old place to the new one; scores that changed flash once.
  app.querySelectorAll(".lrow").forEach(r=>{ const was=prevRects.get(r.dataset.k); const now=r.getBoundingClientRect().top;
    const sc=r.querySelector(".lscore").dataset.s; if(prevScores.has(r.dataset.k)&&prevScores.get(r.dataset.k)!==sc) r.classList.add("flash"); prevScores.set(r.dataset.k,sc);
    if(was!=null&&was!==now){ r.style.transition="none"; r.style.transform="translateY("+(was-now)+"px)"; requestAnimationFrame(()=>requestAnimationFrame(()=>{ r.style.transition=""; r.style.transform=""; })); } });
  prevRects=new Map();
  $("#upd").textContent=s.running?("evaluating"+(s.running>1?" "+s.running+" subjects":"")+"…"):s.updatedAt?"updated "+new Date(s.updatedAt).toLocaleTimeString():"waiting for evaluations";
}
async function refresh(){ try{ const r=await fetch("/api/state",{cache:"no-store"}); const t=await r.text(); if(t!==last){ last=t; render(JSON.parse(t)); } }catch{} }
// Polls; refresh() is also exposed so a recorder or test can update the page on demand.
window.verdictWatchRefresh=refresh;
(function tick(){ refresh().finally(()=>setTimeout(tick,700)); })();
</script></body></html>`;
}
