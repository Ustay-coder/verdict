/**
 * The `verdict watch` page: one HTML document that polls /api/state and redraws.
 * The style is a constant; the script is the compiled source of client.ts, so the page needs no bundler.
 * Leaderboard rows that change place slide to their new rank, and scores that change flash once.
 */
import { CLIENT_FUNCTIONS } from "./client.js";
import { COMPARE_FUNCTIONS } from "./compare-client.js";

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

function nav(on: "evaluations" | "compare"): string {
  return `<nav><a href="/"${on === "evaluations" ? ' class="on"' : ""}>Evaluations</a><a href="/compare"${on === "compare" ? ' class="on"' : ""}>Compare runs</a></nav>`;
}

/** The comparison screen: two stored runs case by case. Loads once per selection; it does not poll. */
export function comparePage(source = ".verdict"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>verdict watch — compare</title><style>${STYLE}${COMPARE_STYLE}</style></head><body>
<header><b>verdict watch</b>${nav("compare")}<span class="src">${stripMarkup(source)}</span><span class="live"><span id="upd">loading…</span></span></header>
<main id="app"><div class="empty">Loading the comparison…</div></main>
<script>${COMPARE_SCRIPT}</script></body></html>`;
}
