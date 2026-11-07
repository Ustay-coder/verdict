// Plain working video for the judge loop: Claude Code, the rubric it edits, and how often Verdict agreed with people.
//   Terminal: the recorded terminal bytes at their recorded times (model and plan label blanked).
//   Rubric:   commit-review.yaml as it was at each moment (build_timeline.py states); lines the last edit added are
//             highlighted.
//   Agreement: the agent's own check_against_humans results: how many of the 48 verdicts match the human labels, the
//             history, the developers' 85% for reference, and one square per commit message (green: same verdict as
//             the humans, red: not, grey: handed to a human), grouped by what the humans said.
// Only a speed label is added; the optional cold open shows the finished state first.
//   node plain2pane-agree.mjs <take-dir> <timeline-dir> out.mp4 [--warp w.json] [--layout wide|vertical] [--still s out.png]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const [takeDir, tlDir, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const mods = [process.env.XTERM_MODULES, join(here, "node_modules")].filter(Boolean).find((m) => { try { readdirSync(join(m, "@xterm")); return true; } catch { return false; } });
const fps = 30, TAIL = 3;
const TITLE = opt("title", "claude — ~/commit-review"), FILE_LABEL = opt("file", "commit-review.yaml");
const WARP = opt("warp", null) ? JSON.parse(readFileSync(opt("warp"), "utf8")) : null;
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;
const VERT = opt("layout", "wide") === "vertical";
const REF = Number(opt("ref", 85)); // experienced developers vs. these labels (Tian et al.: 102 of 120)

const castFile = readdirSync(takeDir).find((f) => f.endsWith(".cast"));
const redact = (s) => s.replace(/(Opus|Sonnet|Haiku|Fable) \d+(\.\d+)? · Claude (API|Max|Pro|Team|Enterprise)/g, (m) => " ".repeat(m.length));
const cast = readFileSync(join(takeDir, castFile), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === "o").map((e) => [e[0], redact(e[2])]);
const markers = Object.fromEntries(readFileSync(join(takeDir, castFile + ".markers"), "utf8").trim().split("\n").map((l) => l.split("\t")).map(([t, k]) => [k, Number(t)]));
const tl = JSON.parse(readFileSync(join(tlDir, "timeline.json"), "utf8"));

// Each rubric state with the lines that are new since the previous state (LCS line diff).
const added = (a, b) => {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = new Set(); let i = 0, j = 0;
  while (j < m) { if (i < n && a[i] === b[j]) { i++; j++; } else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++; else out.add(j++); }
  return [...out];
};
const states = tl.states.map((s, k) => {
  const lines = readFileSync(join(tlDir, s.file), "utf8").replace(/\n$/, "").split("\n");
  const prev = k ? readFileSync(join(tlDir, tl.states[k - 1].file), "utf8").replace(/\n$/, "").split("\n") : lines;
  return { src: s.src, lines, added: k ? added(prev, lines) : [] };
});
const checks = tl.checks.filter((c) => c.cells); // dev-set checks drive the board
const testCheck = tl.checks.find((c) => !c.cells);
const humans = tl.humans;

const END = (markers.done ?? cast.at(-1)[0]) + TAIL, FROM = Number(opt("from", markers.submitted - 0.5));
const pieces = []; { let t = 0;
  if (WARP?.coldOpen) { pieces.push([0, WARP.coldOpen.seconds, END, END, WARP.coldOpen.label, true]); t = WARP.coldOpen.seconds; }
  for (const [a, b, sp] of WARP?.segments ?? [[FROM, END, 1]]) { const d = (b - a) / sp; pieces.push([t, t + d, a, b, WARP ? (sp === 1 ? "real time" : `${sp}× speed`) : "", false]); t += d; } }
const total = pieces.at(-1)[1];
const at = (t) => { const p = pieces.find((q) => t < q[1]) ?? pieces.at(-1); const k = p[1] > p[0] ? Math.min(1, (t - p[0]) / (p[1] - p[0])) : 0; return { src: p[2] + (p[3] - p[2]) * k, label: p[4], cold: p[5] }; };

const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8"), xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const VW = VERT ? 1080 : 1920, VH = VERT ? 1920 : 1080;
const TFS = VERT ? 15.2 : 12.2, TH = 32 + 16 + 30 * TFS * 1.2 + 8; // terminal: 100×30 cells
const G = VERT
  ? (() => { const ty = VH - TH - 20, sh = 560, cy = ty - 52; return {
      score: { x: 20, y: 20, w: VW - 40, h: sh }, pane: { x: 20, y: 20 + sh + 16, w: VW - 40, h: cy - (20 + sh + 16) - 4 }, term: { x: 20, y: ty, w: VW - 40, h: TH }, chip: { x: 24, y: ty - 42 } }; })()
  : (() => { const lw = 960; return {
      score: { x: 20, y: 20, w: lw, h: VH - TH - 100 }, term: { x: 20, y: VH - TH - 20, w: lw, h: TH }, pane: { x: lw + 40, y: 20, w: VW - lw - 60, h: VH - 40 }, chip: { x: 24, y: VH - TH - 58 } }; })();
const box = (b) => `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
const PER = Math.ceil(tl.humans.filter(Boolean).length / 2), GAP = 6, CELL = Math.min(VERT ? 34 : 30, Math.floor((G.score.w - 44 - GAP * (PER - 1)) / PER));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;width:${VW}px;height:${VH}px;background:#1c1c1e;overflow:hidden;font-family:Inter,sans-serif;color:#e6e6e6}
.win{position:absolute;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #3a3a3e}
.bar{height:32px;line-height:32px;padding:0 12px;font:500 13px Inter;color:#9a9aa2;background:#2a2a2d;white-space:nowrap;overflow:hidden}
#tw{${box(G.term)};background:#141414}#term{padding:8px 10px}
#pw{${box(G.pane)};background:#141414}
#code{position:absolute;top:32px;left:0;right:0;bottom:0;overflow:hidden;padding:10px 0;font:400 ${VERT ? 15 : 15}px/1.45 "JetBrains Mono",monospace;color:#cfcfd4}
#code .l{white-space:pre-wrap;word-break:break-word;padding:0 14px 0 52px;text-indent:-38px;min-height:1.45em}
#code .l i{display:inline-block;width:30px;margin-right:8px;text-align:right;color:#55555c;font-style:normal;text-indent:0}
#code .l.new{background:#12301d;color:#d8f5e1}#code .l.new i{color:#2c7a46}
#code .k{color:#8fb8ff}#code .c{color:#7d7d86}
#chip{position:absolute;left:${G.chip.x}px;top:${G.chip.y}px;font:500 22px Inter;color:#9a9aa2}
#sc{position:absolute;${box(G.score)};background:#141414;border-radius:10px;box-shadow:0 0 0 1px #3a3a3e;padding:18px 22px;box-sizing:border-box}
#cap{font:500 ${VERT ? 20 : 20}px Inter;color:#9a9aa2}
#top{display:flex;align-items:baseline;gap:16px;margin-top:6px}
#num{font:600 ${VERT ? 96 : 100}px/1 Inter;font-variant-numeric:tabular-nums;color:#fff}
#frac{font:500 ${VERT ? 26 : 26}px Inter;color:#cfcfd4;font-variant-numeric:tabular-nums}
#hist{font:500 ${VERT ? 21 : 22}px Inter;color:#9a9aa2;margin-top:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
#hist b{color:#fff}
#bar{position:relative;height:10px;border-radius:5px;background:#2a2a2d;margin-top:14px}
#fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:#3d8f5a}
#ref{position:absolute;top:-6px;bottom:-6px;width:2px;background:#e6e6e6}
#reflbl{position:absolute;top:14px;transform:translateX(-50%);font:500 14px Inter;color:#cfcfd4;white-space:nowrap}
.grp{margin-top:${VERT ? 34 : 34}px;font:500 16px Inter;color:#9a9aa2}
.cells{display:flex;flex-wrap:wrap;gap:${GAP}px;margin-top:8px}
.cell{width:${CELL}px;height:${CELL}px;border-radius:5px;background:#2a2a2d}
.cell.agree{background:#2f8a4f}.cell.disagree{background:#9b3434}.cell.asked{background:#6b6b73}
.cell.flip{box-shadow:0 0 0 3px #e6e6e6}
#legend{display:flex;gap:18px;margin-top:16px;font:500 15px Inter;color:#9a9aa2}
#legend span:before{content:"";display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px;background:var(--c)}
#pills{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.pill{font:500 17px Inter;padding:5px 12px;border-radius:999px;background:#2a2a2d;color:#cfcfd4}
#test{margin-top:14px;font:600 20px Inter;color:#fff}
#empty{font:500 18px Inter;color:#9a9aa2;margin-top:12px}
</style></head><body>
<div id="chip"></div>
<div id="sc"><div id="cap">Verdicts that match the human reviewers (${humans.length} commit messages)</div>
<div id="board"><div id="top"><span id="num">–</span><span id="frac"></span></div><div id="hist"></div>
<div id="bar"><div id="fill"></div><div id="ref" style="left:${REF}%"></div><div id="reflbl" style="left:${REF}%">experienced developers: ${REF}%</div></div>
<div class="grp">Humans said: good</div><div class="cells" id="g1"></div>
<div class="grp" style="margin-top:14px">Humans said: not good</div><div class="cells" id="g0"></div>
<div id="legend"><span style="--c:#2f8a4f">same verdict</span><span style="--c:#9b3434">different</span><span style="--c:#6b6b73">asked a human</span></div>
<div id="pills"></div><div id="test"></div></div><div id="empty">Not checked yet</div></div>
<div class="win" id="tw"><div class="bar">${TITLE}</div><div id="term"></div></div>
<div class="win" id="pw"><div class="bar">${FILE_LABEL}</div><div id="code"></div></div>
<script>window.CAST=${J(cast)};window.STATES=${J(states)};window.HUM=${J(humans)};</script><script>${xtermJs}</script>
<script>
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono",monospace',fontSize:${TFS},lineHeight:1.2,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open(document.getElementById("term"));
let ci=0; window.resetTerm=()=>{term.reset();ci=0;}; window.chip=(t)=>{document.getElementById("chip").textContent=t;};
window.feedTo=async(src)=>{let s="";while(ci<CAST.length&&CAST[ci][0]<=src) s+=CAST[ci++][1]; if(s) await new Promise(r=>term.write(s,r));};
const esc=(s)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
const hl=(s)=>{const e=esc(s); if(/^\\s*#/.test(s)) return '<span class="c">'+e+'</span>'; return e.replace(/^(\\s*-?\\s*)([A-Za-z_]+):/,'$1<span class="k">$2</span>:');};
window.rubric=(k,fresh)=>{const s=STATES[k], code=document.getElementById("code"), nw=new Set(fresh?s.added:[]);
  code.innerHTML=s.lines.map((l,i)=>'<div class="l'+(nw.has(i)?" new":"")+'"><i>'+(i+1)+'</i>'+hl(l)+'</div>').join("");
  // keep the first new line in view
  const first=s.added.length&&fresh?code.children[s.added[0]]:null; code.scrollTop=0;
  if(first){const over=first.offsetTop+first.offsetHeight*Math.min(8,s.added.length)-code.clientHeight; if(over>0) code.scrollTop=over+20;}
};
window.board=(hist,k,shown,flips,test)=>{
  const e=hist[k]; document.getElementById("empty").style.display=e?"none":"block"; document.getElementById("board").style.display=e?"block":"none"; if(!e) return;
  document.getElementById("num").textContent=Math.round(shown)+"%";
  document.getElementById("frac").textContent=e.agreed+" of "+e.decided+(e.askedHuman?" decided · "+e.askedHuman+" asked a human":"");
  document.getElementById("hist").innerHTML=hist.slice(0,k+1).map((h,i)=>{const p=Math.round(100*h.agreed/h.decided)+"%";return i===k?"<b>"+p+"</b>":p;}).join(" → ");
  document.getElementById("fill").style.width=shown+"%";
  for(const [id,want] of [["g1",true],["g0",false]]) document.getElementById(id).innerHTML=e.cells.map((c,i)=>HUM[i]===want?'<div class="cell '+c+(flips.includes(i)?" flip":"")+'"></div>':"").join("");
  const crit=Object.entries(e.criteria).map(([id,c])=>'<span class="pill">'+id+": "+c.agreed+"/"+c.n+"</span>").join("");
  document.getElementById("pills").innerHTML=crit;
  document.getElementById("test").textContent=test?"On "+test.decided+" messages it hadn't seen: "+test.agreed+" of "+test.decided+" ("+Math.round(100*test.agreed/test.decided)+"%)"+(test.askedHuman?", "+test.askedHuman+" asked a human":""):"";
};
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const pct = (c) => (100 * c.agreed) / c.decided;
let shownState = -1, shownFresh = null, wasCold = false, lastK = -2, tween = null;
async function frame(t) {
  const a = at(t);
  if (wasCold && !a.cold) { await page.evaluate(() => window.resetTerm()); shownState = -1; lastK = -2; }
  wasCold = a.cold;
  await page.evaluate((s) => window.feedTo(s), a.src);
  let i = 0; states.forEach((s, j) => { if (s.src <= a.src) i = j; });
  let k = -1; checks.forEach((c, j) => { if (c.src <= a.src) k = j; });
  // new lines stay highlighted until the next check comes back
  const fresh = i > 0 && (k < 0 || checks[k].src < states[i].src || checks[k].state === i);
  if (i !== shownState || fresh !== shownFresh) { shownState = i; shownFresh = fresh; await page.evaluate(([s, f]) => window.rubric(s, f), [i, fresh]); }
  if (k !== lastK) {
    const from = k > 0 ? pct(checks[k - 1]) : 0, flips = k > 0 ? checks[k].cells.map((c, j) => (c !== checks[k - 1].cells[j] ? j : -1)).filter((j) => j >= 0) : [];
    tween = { t0: t, from: a.cold ? (k >= 0 ? pct(checks[k]) : 0) : from, to: k >= 0 ? pct(checks[k]) : 0, flips }; lastK = k;
  }
  const kk = Math.min(1, (t - (tween?.t0 ?? 0)) / 0.8), cur = tween ? tween.from + (tween.to - tween.from) * (1 - (1 - kk) ** 3) : 0;
  const test = testCheck && testCheck.src <= a.src ? testCheck : null;
  await page.evaluate(([h, k, s, f, x]) => window.board(h, k, s, f, x), [checks, k, cur, t - (tween?.t0 ?? 0) < 1.6 ? tween?.flips ?? [] : [], test]);
  await page.evaluate((l) => window.chip(l), a.label);
}
if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await frame(v);
  await page.screenshot({ path: stillOut }); await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${total.toFixed(1)}s, ${states.length} states, ${checks.length} checks)`); process.exit(0);
}
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(total * fps);
for (let f = 0; f < frames; f++) {
  await frame(f / fps);
  const img = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once("drain", r));
}
ff.stdin.end(); await new Promise((r) => ff.on("close", r)); await browser.close();
console.log(`wrote ${outPath}: ${total.toFixed(1)}s (${WARP ? "variable speed" : "real time"}), ${states.length} rubric states, agreement ${checks.map((c) => Math.round(pct(c)) + "%").join(" → ")}`);
