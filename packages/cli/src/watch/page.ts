/**
 * The `verdict watch` page: one HTML document that polls /api/state and redraws.
 * The style is a constant; the script is the compiled source of client.ts, so the page needs no bundler.
 * Leaderboard rows that change place slide to their new rank, and scores that change flash once.
 */
import { CLIENT_FUNCTIONS } from "./client.js";
import { CHANGE_APP_FUNCTIONS } from "./change-app.js";
import { CHANGE_SETUP_FUNCTIONS } from "./change-client.js";
import { CHANGE_RESULT_FUNCTIONS } from "./change-results.js";
import { escapeHtml, lineDiff } from "./client.js";
import { COMPARE_FUNCTIONS, foldRows } from "./compare-client.js";

const STYLE = `
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
.lname{font-weight:600}.lhist{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;margin-top:2px}.lhist b{color:var(--text)}
.delta{display:block;font-size:12px;font-weight:600;margin-top:2px}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}.prev{color:var(--muted);font-size:13px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}
.mini{display:grid;gap:3px}.mini div{display:grid;grid-template-columns:86px 1fr 30px;gap:6px;align-items:center;font-size:11px;color:var(--muted)}.mini .bar{margin:0;height:5px}
.lscore{text-align:right;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.lscore small{display:block;font-size:11px;color:var(--muted);font-weight:500}
.flash{animation:flash 1.2s}@keyframes flash{0%{background:#fff4d6}100%{background:var(--panel)}}
.empty{color:var(--muted);padding:60px;text-align:center}
nav a{color:var(--muted);text-decoration:none;margin-right:12px;font-size:13px}nav a.on{color:var(--text);font-weight:600}
`;

// Comparison screen additions; the shared style above still applies.
const COMPARE_STYLE = `
.picker{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}.picker label{display:grid;gap:3px;font-size:12px;color:var(--muted)}.picker select{font:13px inherit;padding:4px 6px;max-width:420px}
.kind{padding:12px 14px;border-radius:8px;margin-bottom:16px;border:1px solid var(--line);background:var(--panel)}.kind.k-rubric_change,.kind.k-policy_change{border-color:#b7c8f5;background:#eef3ff}.kind.k-different_conditions{border-color:#f3c98b;background:#fff6e8}
.differs{margin-top:4px;font-size:12px;color:var(--muted)}code{font:12px ui-monospace,Menlo,monospace;background:#eef1f6;border-radius:4px;padding:0 4px}
.kinds{padding:8px 14px;border-bottom:1px solid var(--line);display:flex;gap:6px;flex-wrap:wrap;align-items:center}.note{color:var(--muted);font-size:12px}
.crit-panel{margin-bottom:16px}.cid{font-weight:650;font-size:15px}.agree .big{font-size:28px}.counts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.denom{margin-top:6px}
.chip.bad{color:var(--bad);border-color:#f3b4a3}.chip.good{color:var(--good);border-color:#9fd4b0}.chip.warn{color:var(--warn);border-color:#f3c98b}.muted{color:var(--muted);font-size:12px}
.case{border-top:1px solid var(--line)}.case summary{padding:9px 16px;cursor:pointer;list-style:none}.case summary::-webkit-details-marker{display:none}.case .mark{display:inline-block;width:18px;font-weight:700}
.c-regressed .mark{color:var(--bad)}.c-fixed .mark{color:var(--good)}.cbody{padding:0 16px 12px 34px}.preview{white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,monospace;background:#f6f7f9;border-radius:6px;padding:8px;margin:0 0 8px}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}.sh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}
.doc pre .fold{color:var(--muted);font-style:italic;background:#f6f7f9}
.pb{display:grid;grid-template-columns:90px 1fr 36px;gap:6px;align-items:center;font-size:11px;color:var(--muted)}.pb .bar{margin:0;height:5px}.cli{margin-top:10px}
`;

// why: the page polls about once a second; faster adds load without making results appear sooner.
const POLL_MS = 700;

// The browser code is ordinary type-checked TypeScript (client.ts), shipped as source text.
const SCRIPT = `${CLIENT_FUNCTIONS.map((f) => f.toString()).join("\n")}\nstart(${POLL_MS});`;

const COMPARE_SCRIPT = `${COMPARE_FUNCTIONS.map((f) => f.toString()).join("\n")}\nstartCompare();`;

// The label comes from the local environment; dropping markup characters is enough to keep it inert.
const stripMarkup = (s: string) => s.replace(/[<>&]/g, "");

/** The page for a data directory label; the label is shown in the header only. */
export function watchPage(source = ".verdict"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>verdict watch</title><style>${STYLE}</style></head><body>
<header><b>verdict watch</b>${nav("evaluations")}<span class="src">${stripMarkup(source)}</span><span class="live"><span class="dot"></span><span id="upd">waiting for evaluations</span></span></header>
<main id="app"><div class="empty">No evaluations yet. Run one and it shows up here.</div></main>
<script>${SCRIPT}</script></body></html>`;
}

function nav(on: "evaluations" | "compare" | "change"): string {
  const link = (href: string, key: typeof on, label: string) => `<a href="${href}"${on === key ? ' class="on" aria-current="page"' : ""}>${label}</a>`;
  return `<nav>${link("/", "evaluations", "Evaluations")}${link("/compare", "compare", "Compare runs")}${link("/change-tests", "change", "Change tests")}</nav>`;
}

/** The comparison screen: two stored runs case by case. Loads once per selection; it does not poll. */
export function comparePage(source = ".verdict"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>verdict watch — compare</title><style>${STYLE}${COMPARE_STYLE}</style></head><body>
<header><b>verdict watch</b>${nav("compare")}<span class="src">${stripMarkup(source)}</span><span class="live"><span id="upd">loading…</span></span></header>
<main id="app"><div class="empty">Loading the comparison…</div></main>
<script>${COMPARE_SCRIPT}</script></body></html>`;
}

// Change-test screens; the shared style above still applies. Every status has a mark and a word, so none of this
// depends on colour, and the layout folds to one column on a narrow screen.
const CHANGE_STYLE = `
header{flex-wrap:wrap}main{max-width:1500px;margin:0 auto}h2{font-size:15px;margin:0 0 10px}h3{font-size:13px;margin:0 0 8px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}a{color:var(--accent)}
.lede{max-width:820px;margin:0 0 14px}.pad{padding:14px 16px}.panel{margin-bottom:14px}.row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.crumb{font-size:13px;color:var(--muted);margin-bottom:8px}.meta{color:var(--muted);font-size:13px;margin:-6px 0 10px}.intent{margin:4px 0 8px;white-space:pre-wrap}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 14px}.muted{color:var(--muted);font-size:12px}small.muted{display:block}
.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid #b9bfca;background:#fff;color:var(--text);cursor:pointer;text-decoration:none;display:inline-block}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.small{font-size:12px;padding:3px 9px}.btn[disabled]{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;font-size:13px;padding:6px 8px;border:1px solid #b9bfca;border-radius:6px;background:#fff;color:var(--text);max-width:100%}textarea{width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.field{display:grid;gap:4px;margin-bottom:12px}.field>span{font-size:12px;color:var(--muted)}.field select,.field input{width:100%}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.form{padding:14px 16px}
.check{font-size:13px}.fold>summary{cursor:pointer;padding:8px 0;font-size:13px;color:var(--accent)}details.panel.fold>summary{padding:10px 16px}.docf{border:1px solid var(--line);border-radius:6px;margin:0 0 10px;padding:8px 12px}
.banner{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);margin:0 0 12px}.banner ul{margin:6px 0 0 18px;padding:0}
.banner.ok{border-color:#9fd4b0;background:#eef8f1}.banner.warn{border-color:#f3c98b;background:#fff6e8}.banner.bad{border-color:#f3b4a3;background:#fdeee9}.banner.demo{border-color:#c9b8f0;background:#f4f0ff}
.chip.demo{color:#5b3fb5;border-color:#c9b8f0;background:#f4f0ff;font-weight:600}.tlist{list-style:none;margin:0;padding:0}.tcard{padding:12px 16px}.tname{font-weight:650;font-size:15px}
.plain{list-style:none;margin:4px 0;padding:0}.plain li{padding:3px 0}.trials li{border-top:1px solid var(--line);padding:7px 0;font-size:13px}
.vs{display:inline-block;font-size:12px;font-weight:650;border-radius:999px;padding:1px 9px;border:1px solid;white-space:nowrap;background:#fff}
.vs-met,.conn-ready{color:var(--good);border-color:#9fd4b0}.vs-unmet,.conn-missing{color:var(--bad);border-color:#f3b4a3}.vs-needs_review{color:var(--warn);border-color:#f3c98b}
.vs-incomparable{color:#344054;border-style:dashed;border-color:#98a2b3}.vs-unverified,.vs-pending,.conn-none{color:#475467;border-style:dotted;border-color:#98a2b3}.conn-mock{color:#5b3fb5;border-color:#c9b8f0}
.changes{list-style:none;margin:0 0 8px;padding:0}.changes li{padding:7px 0;border-top:1px solid var(--line)}.changes li:first-child{border-top:0}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px}.bav{font:12px/1.5 ui-monospace,Menlo,monospace;background:#f6f7f9;border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-word}
.sbs-wrap,.tbl-wrap{overflow-x:auto}.sbs{width:100%;border-collapse:collapse;table-layout:fixed}.sbs th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:4px 8px}
.sbs td{width:50%;white-space:pre-wrap;word-break:break-word;vertical-align:top;padding:1px 8px;font:12px/1.55 ui-monospace,Menlo,monospace}.sbs .del{background:#fdecea}.sbs .del::before{content:"− "}
.sbs .add{background:var(--add)}.sbs .add::before{content:"+ "}.sbs .void{background:#f6f7f9}.sbs .fold{color:var(--muted);font-style:italic;background:#f6f7f9}
.ecase{border:1px solid var(--line);border-radius:8px;margin:0 0 12px;padding:6px 14px 12px}.ecase legend{font-weight:600;padding:0 6px}
.exp{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:8px 0;border-top:1px dashed var(--line);font-size:13px}.exp input[type=number]{width:84px}.exp small{color:var(--muted)}.none{padding:6px 0}
.conn{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:8px}.scope ul{margin:4px 0 4px 18px;padding:0}.scope li{margin:4px 0}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:6px}.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tl{font-size:13px;padding:1px 0}.tl b{font-variant-numeric:tabular-nums;font-size:15px}.rate{font-size:15px}.rate b{font-size:22px;font-variant-numeric:tabular-nums}.counts{margin-top:6px;font-size:12px;line-height:2}
.work{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(360px,1fr);gap:16px;align-items:start}.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px;font-size:13px}
.bars{border-bottom:1px solid var(--line)}.cbar{display:grid;grid-template-columns:32% minmax(0,1fr) 48px 132px;gap:10px;align-items:center;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--line);padding:8px 6px;font:inherit;font-size:13px;color:var(--text);cursor:pointer}
.cbar.flat{grid-template-columns:32% minmax(0,1fr) 132px}.cbar:hover{background:#f6f7f9}.cbar.sel,tr.sel{background:#eef3ff;box-shadow:inset 3px 0 var(--accent)}
.cbar .vs{justify-self:start}.unlinked .chip{display:inline-block;margin-top:2px;white-space:nowrap}.bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bv{font-variant-numeric:tabular-nums;font-weight:650;text-align:right}.because{color:#475467;font-size:12px}
.track{position:relative;height:16px;background:#eef1f6;border-radius:3px}.zero{position:absolute;left:calc(50% - 1px);top:-4px;bottom:-4px;width:2px;background:#344054}
.fill{position:absolute;top:2px;bottom:2px;border-radius:2px}.fill.up{background:#344054}.fill.down{background:repeating-linear-gradient(135deg,#344054 0 3px,#d0d5dd 3px 6px);border:1px solid #344054}
.zdot{position:absolute;left:calc(50% - 6px);top:2px;width:12px;height:12px;border-radius:50%;border:2px solid #344054;background:#fff}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#475467;margin:8px 0}.sw{position:static;display:inline-block;width:22px;height:10px;vertical-align:-1px}.noplot{margin-top:10px}
table.cases,table.matrix{width:100%;border-collapse:collapse;font-size:13px}.cases th,.matrix th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line);font-weight:600}
.cases td,.matrix td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}.cases th{white-space:nowrap;padding:8px}.cases td:first-child{min-width:120px}.cases td small{display:block}.cases tbody tr{cursor:pointer}.cases tbody tr:hover{background:#f6f7f9}.cases tr.sel:hover{background:#eef3ff}
.rowbtn{font:inherit;font-weight:600;background:none;border:0;padding:0;color:var(--accent);cursor:pointer;text-align:left}.sc,.dl{font-variant-numeric:tabular-nums;font-size:15px}
.nos{color:#475467;font-style:italic}.ex-failed,.ex-invalid_output{color:var(--bad);font-style:normal;font-weight:600}.ex{display:block}.ex i{color:var(--muted);font-size:11px;font-style:normal}
.matrix tbody th{text-transform:none;letter-spacing:0;font-size:13px}.mdown,.mup{font-variant-numeric:tabular-nums;font-weight:600}
.detail{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto}.empty-detail{position:static}.dhead{position:sticky;top:0;z-index:1;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dhead h2{margin:0;font-size:16px}.dnav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}.eres .chip{display:inline-block;border-radius:8px;margin-top:2px}.eres li{padding:6px 0;border-top:1px solid var(--line)}.eres li:first-child{border-top:0}
.sides2{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.side{padding:12px 16px;min-width:0}.side+.side{border-left:1px solid var(--line)}
.totalline{margin-bottom:8px}.ccard{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}.ccard .row{justify-content:space-between}.cname{font-weight:600}.cscore{margin:4px 0}.cscore .sc{font-size:22px}
.cdesc,.ans,.asks,.reason,.quotes{margin-top:6px;font-size:13px}.reason p{margin:2px 0}.unlinked{color:#475467}
.quote{font:inherit;font-size:13px;text-align:left;background:#f6f7f9;border:0;border-left:3px solid var(--accent);padding:3px 8px;cursor:pointer;color:var(--text);border-radius:0 4px 4px 0}.quote:hover{text-decoration:underline}
.doctext{margin:4px 0 0;font:12.5px/1.65 ui-monospace,Menlo,D2Coding,monospace;white-space:pre-wrap;word-break:break-word;background:#f6f7f9;border-radius:6px;padding:10px 12px}
mark{background:#fff1b8;border-radius:2px;padding:0 1px;box-shadow:0 0 0 1px #e9c46a}mark.hit{outline:3px solid var(--accent);outline-offset:1px}
.bar2{height:6px;background:#eef1f6;border-radius:3px;margin-top:8px;overflow:hidden}.bar2 i{display:block;height:100%;background:var(--accent)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:6px 0;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0}.layer-structure,.layer-judgment,.layer-policy,.layer-binding{font-weight:600}
@media (max-width:1100px){.work{grid-template-columns:1fr}.detail{position:static;max-height:none}.tiles{grid-template-columns:1fr}}
@media (max-width:760px){main{padding:14px 12px}.two,.conn,.ba,.sides2{grid-template-columns:1fr}.side+.side{border-left:0;border-top:1px solid var(--line)}
.cases thead{position:absolute;left:-9999px}.cases tr{display:block;padding:8px 10px;border-bottom:1px solid var(--line)}.cases td{display:block;border:0;padding:3px 0;text-align:right;overflow:hidden}.cases td:first-child{min-width:0}
.cases td::before{content:attr(data-l);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;float:left;margin-right:10px}.cases td small{text-align:right}
.cbar{grid-template-columns:minmax(0,1fr) 48px 132px}.cbar .bl{grid-column:1/-1}.cbar.flat{grid-template-columns:minmax(0,1fr) 132px}.cbar.flat .bl{grid-column:1/-1}.dnav{margin-left:0}.kv{grid-template-columns:1fr}}
`;

const CHANGE_SCRIPT = [escapeHtml, lineDiff, foldRows, ...CHANGE_SETUP_FUNCTIONS, ...CHANGE_RESULT_FUNCTIONS, ...CHANGE_APP_FUNCTIONS].map((f) => f.toString()).join("\n");

/**
 * The change-test screens. `token` rides in the page and must come back with every write: a page on another origin
 * cannot read it, so it cannot write. It is random hex, safe to place in a script as a string literal.
 */
export function changePage(source = ".verdict", token = ""): string {
  if (!/^[0-9a-f]*$/.test(token)) throw new Error("the watch token must be hex");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>verdict watch — change tests</title><style>${STYLE}${COMPARE_STYLE}${CHANGE_STYLE}</style></head><body>
<header><b>verdict watch</b>${nav("change")}<span class="src">${stripMarkup(source)}</span><span class="live"><span id="upd" role="status">loading…</span></span></header>
<main id="app"><div class="empty">Loading…</div></main>
<script>${CHANGE_SCRIPT}\nstartChange("${token}", ${POLL_MS});</script></body></html>`;
}
