// Plain working video for a landing page loop: Claude Code, the page it edits, and the score it got.
//   Terminal: the recorded terminal bytes at their recorded times (model and plan label blanked).
//   Page: the real page (1280 px wide, first screen), reloaded at the moment each Edit/Write landed, plus a strip with
//         the whole page (full-page screenshot of the same state), so changes below the fold show too.
//   Score: the agent's own evaluate results (build_states.py timeline): the score, its history, and the seven checks of
//          landing-review-strict.yaml as pass/fail pills (the gate plus the six checks of the formula).
// Only a speed label is added ("40× speed", "real time"); the optional cold open shows the finished state first.
//   node plain2pane-page.mjs <take-dir> <states-dir> out.mp4 [--warp w.json] [--layout wide|vertical] [--title t] [--url u] [--still s out.png]
//   take-dir: run.cast + run.cast.markers (record.py); states-dir: build_states.py output (timeline.json + states/NN.html)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const [takeDir, statesDir, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const mods = [process.env.XTERM_MODULES, join(here, "node_modules")].filter(Boolean).find((m) => { try { readdirSync(join(m, "@xterm")); return true; } catch { return false; } });
const fps = 30, TAIL = 3;
const TITLE = opt("title", "claude — ~/tideline"), URL_LABEL = opt("url", "127.0.0.1:8772 — index.html");
const WARP = opt("warp", null) ? JSON.parse(readFileSync(opt("warp"), "utf8")) : null;
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;
const VERT = opt("layout", "wide") === "vertical";

const castFile = readdirSync(takeDir).find((f) => f.endsWith(".cast"));
const redact = (s) => s.replace(/(Opus|Sonnet|Haiku|Fable) \d+(\.\d+)? · Claude (API|Max|Pro|Team|Enterprise)/g, (m) => " ".repeat(m.length));
const cast = readFileSync(join(takeDir, castFile), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === "o").map((e) => [e[0], redact(e[2])]);
const markers = Object.fromEntries(readFileSync(join(takeDir, castFile + ".markers"), "utf8").trim().split("\n").map((l) => l.split("\t")).map(([t, k]) => [k, Number(t)]));
const tl = JSON.parse(readFileSync(join(statesDir, "timeline.json"), "utf8"));
const states = tl.states.map((s) => ({ src: s.src, file: s.file.split("/").pop() }));
const CHECKS = [
  ["honest_proof", "No invented proof", true], ["facts_true", "Figures from facts"], ["decoration", "No glows or gradients"],
  ["motion", "No looping motion"], ["template_chrome", "No template chrome"], ["contrast", "AA contrast"], ["plain_copy", "Plain headings"],
];
const evals = tl.evals.map((e) => {
  const n = Object.fromEntries(e.criteria.map((c) => [c.id, c.n]));
  return { src: e.src, score: e.score, grade: e.grade, pass: CHECKS.map(([id]) => (["honest_proof", "plain_copy"].includes(id) ? n[id] >= 0.5 : n[id] >= 1)) };
});

const END = (markers.done ?? cast.at(-1)[0]) + TAIL, FROM = Number(opt("from", markers.submitted - 0.5));
const KO = opt("lang", "en") === "ko";
const pieces = []; { let t = 0;
  if (WARP?.coldOpen) { pieces.push([0, WARP.coldOpen.seconds, END, END, WARP.coldOpen.label, true]); t = WARP.coldOpen.seconds; }
  for (const [a, b, sp] of WARP?.segments ?? [[FROM, END, 1]]) { const d = (b - a) / sp; pieces.push([t, t + d, a, b, WARP ? (KO ? (sp === 1 ? "실제 속도" : `${sp}배속`) : (sp === 1 ? "real time" : `${sp}× speed`)) : "", false]); t += d; } }
const total = pieces.at(-1)[1];
const at = (t) => { const p = pieces.find((q) => t < q[1]) ?? pieces.at(-1); const k = p[1] > p[0] ? Math.min(1, (t - p[0]) / (p[1] - p[0])) : 0; return { src: p[2] + (p[3] - p[2]) * k, label: p[4], cold: p[5] }; };

const browser = await chromium.launch();
const route = (ctx) => ctx.route("http://take.local/**", (r) => r.fulfill({ path: join(statesDir, "states", new URL(r.request().url()).pathname.split("/").pop()), contentType: "text/html" }));

// Full-page screenshots of every state, once (scrolled through first so scroll-triggered reveals have fired).
const fullDir = join(statesDir, "full"); mkdirSync(fullDir, { recursive: true });
{ const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.5 }); await route(c);
  for (const s of states) {
    const png = join(fullDir, s.file.replace(".html", ".png")); if (existsSync(png)) continue;
    const p = await c.newPage(); await p.goto(`http://take.local/${s.file}`, { waitUntil: "load" });
    for (let y = 0; y < 12000; y += 500) { await p.mouse.wheel(0, 500); await p.waitForTimeout(60); }
    await p.waitForTimeout(1200); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
    await p.screenshot({ path: png, fullPage: true }); await p.close();
  }
  await c.close(); }
const fullUri = (f) => "data:image/png;base64," + readFileSync(join(fullDir, f.replace(".html", ".png"))).toString("base64");
const fulls = Object.fromEntries(states.map((s) => [s.file, fullUri(s.file)]));

const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8"), xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const VW = VERT ? 1080 : 1920, VH = VERT ? 1920 : 1080;
const TFS = VERT ? 15.2 : 12.2, TH = 32 + 16 + 30 * TFS * 1.2 + 8; // terminal: 100×30 cells
const MAPW = VERT ? 170 : 190;
// geometry: page pane (window incl. bar), score panel, terminal, chip
const G = VERT
  ? (() => { const tw = VW - 40, ty = VH - TH - 20, sh = 196, sy = ty - 52 - sh, py = 20, ph = sy - 16 - py; return {
      pane: { x: 20, y: py, w: VW - 40, h: ph }, score: { x: 20, y: sy, w: VW - 40, h: sh }, term: { x: 20, y: ty, w: tw, h: TH }, chip: { x: 24, y: ty - 42 } }; })()
  : (() => { const pw = 1150; return {
      pane: { x: VW - pw - 20, y: 20, w: pw, h: VH - 40 }, score: { x: 20, y: 20, w: VW - pw - 60, h: VH - TH - 100 }, term: { x: 20, y: VH - TH - 20, w: VW - pw - 60, h: TH }, chip: { x: 24, y: VH - TH - 58 } }; })();
const PAGEW = 1280, SC = (G.pane.w - MAPW - 1) / PAGEW;
const box = (b) => `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;width:${VW}px;height:${VH}px;background:#1c1c1e;overflow:hidden;font-family:Inter,sans-serif;color:#e6e6e6}
.win{position:absolute;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #3a3a3e}
.bar{height:32px;line-height:32px;padding:0 12px;font:500 13px Inter;color:#9a9aa2;background:#2a2a2d;white-space:nowrap;overflow:hidden}
#tw{${box(G.term)};background:#141414}#term{padding:8px 10px}
#pw{${box(G.pane)};background:#fff}
#vp{position:absolute;top:32px;left:0;width:${PAGEW}px;height:${(G.pane.h - 32) / SC}px;transform:scale(${SC});transform-origin:0 0;border:0;background:#fff}
#map{position:absolute;top:32px;right:0;width:${MAPW}px;height:${G.pane.h - 32}px;background:#2a2a2d;border-left:1px solid #3a3a3e;overflow:hidden}
#map img{width:100%;display:block}
#map .lbl{position:absolute;left:0;right:0;bottom:0;padding:4px 8px;font:500 11px Inter;color:#9a9aa2;background:#2a2a2dcc}
#chip{position:absolute;left:${G.chip.x}px;top:${G.chip.y}px;font:500 22px Inter,NanumGothic;color:#9a9aa2}
#sc{position:absolute;${box(G.score)};background:#141414;border-radius:10px;box-shadow:0 0 0 1px #3a3a3e;padding:16px 20px;box-sizing:border-box}
#top{display:flex;align-items:baseline;gap:14px;${VERT ? '' : 'flex-wrap:wrap'}}
#num{font:600 ${VERT ? 64 : 104}px/1 Inter;font-variant-numeric:tabular-nums;color:#fff;min-width:96px}
#grade{font:600 ${VERT ? 20 : 26}px Inter;padding:3px 10px;border-radius:6px;background:#3a3a3e;color:#e6e6e6}
#grade.ship{background:#1f6f3a;color:#fff}#grade.almost{background:#8a6d0b;color:#fff}#grade.rework{background:#7a2626;color:#fff}
#hist{${VERT ? '' : 'flex-basis:100%;margin-top:14px;'}font:500 ${VERT ? 19 : 24}px Inter;color:#9a9aa2;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
#hist b{color:#fff}
#pills{display:flex;flex-wrap:wrap;gap:${VERT ? 8 : 12}px;margin-top:${VERT ? 16 : 30}px}
.pill{font:500 ${VERT ? 17 : 21}px Inter;padding:${VERT ? '5px 11px' : '8px 15px'};border-radius:999px;background:#2a1717;color:#f0a8a8;box-shadow:inset 0 0 0 1px #6b2a2a;transition:none}
.pill.ok{background:#12301d;color:#9be3b0;box-shadow:inset 0 0 0 1px #2c7a46}
.pill.flash{box-shadow:inset 0 0 0 2px #9be3b0,0 0 0 3px #2c7a4666}
.pill .g{font-size:12px;opacity:.75;margin-left:6px}
#empty{font:500 18px Inter;color:#9a9aa2;margin-top:12px}
</style></head><body>
<div id="chip"></div>
<div id="sc"><div id="top"><span id="num">–</span><span id="grade"></span><span id="hist"></span></div><div id="pills"></div><div id="empty">Not scored yet</div></div>
<div class="win" id="tw"><div class="bar">${TITLE}</div><div id="term"></div></div>
<div class="win" id="pw"><div class="bar">${URL_LABEL}</div><iframe id="vp"></iframe><div id="map"><img id="mi"><div class="lbl">whole page</div></div></div>
<script>window.CAST=${J(cast)};window.FULL=${J(fulls)};window.CHECKS=${J(CHECKS)};</script><script>${xtermJs}</script>
<script>
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono","NanumGothicCoding",monospace',fontSize:${TFS},lineHeight:1.2,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open(document.getElementById("term"));
let ci=0; window.resetTerm=()=>{term.reset();ci=0;}; window.chip=(t)=>{document.getElementById("chip").textContent=t;};
window.feedTo=async(src)=>{let s="";while(ci<CAST.length&&CAST[ci][0]<=src) s+=CAST[ci++][1]; if(s) await new Promise(r=>term.write(s,r));};
window.load=(f)=>new Promise((r)=>{const v=document.getElementById("vp"); v.onload=()=>r(); v.src="http://take.local/"+f; document.getElementById("mi").src=FULL[f];});
// score panel: k = index of the latest evaluation (-1: none yet), shown = the number on screen (tweened by the renderer)
window.score=(hist,k,shown,flash)=>{
  const e=hist[k]; document.getElementById("empty").style.display=e?"none":"block";
  document.getElementById("num").textContent=e?Math.round(shown):"–";
  const g=document.getElementById("grade"); g.textContent=e?e.grade:""; g.className=e?e.grade.split(" ").pop():""; g.style.display=e?"":"none";
  document.getElementById("hist").innerHTML=e?hist.slice(0,k+1).map((h,i)=>i===k?"<b>"+h.score+"</b>":h.score).join(" → "):"";
  document.getElementById("pills").innerHTML=e?CHECKS.map(([id,name,gate],i)=>'<span class="pill'+(e.pass[i]?" ok":"")+(flash.includes(i)?" flash":"")+'">'+(e.pass[i]?"✓ ":"✗ ")+name+(gate?'<span class="g">gate</span>':"")+"</span>").join(""):"";
};
</script></body></html>`;

const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
await route(ctx);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
let shown = -1, wasCold = false, lastK = -2, tween = null;
async function frame(t) {
  const a = at(t);
  if (wasCold && !a.cold) { await page.evaluate(() => window.resetTerm()); shown = -1; lastK = -2; }
  wasCold = a.cold;
  await page.evaluate((s) => window.feedTo(s), a.src);
  let i = 0; states.forEach((s, j) => { if (s.src <= a.src) i = j; });
  if (i !== shown) { shown = i; await page.evaluate((f) => window.load(f), states[i].file); await page.waitForTimeout(i === 0 ? 2500 : 700); }
  let k = -1; evals.forEach((e, j) => { if (e.src <= a.src) k = j; });
  if (k !== lastK) { // a new score: count up from the previous one over 0.8 s of video, flash the pills that flipped
    const from = k > 0 ? evals[k - 1].score : 0, flips = k > 0 ? evals[k].pass.map((p, j) => (p !== evals[k - 1].pass[j] ? j : -1)).filter((j) => j >= 0) : [];
    tween = { t0: t, from: a.cold ? evals[k]?.score ?? 0 : from, to: evals[k]?.score ?? 0, flips }; lastK = k;
  }
  const kk = Math.min(1, (t - (tween?.t0 ?? 0)) / 0.8), cur = tween ? tween.from + (tween.to - tween.from) * (1 - (1 - kk) ** 3) : 0;
  await page.evaluate(([h, k, s, f]) => window.score(h, k, s, f), [evals, k, cur, t - (tween?.t0 ?? 0) < 1.6 ? tween?.flips ?? [] : []]);
  await page.evaluate((l) => window.chip(l), a.label);
}
if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await frame(v);
  await page.screenshot({ path: stillOut }); await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${total.toFixed(1)}s, ${states.length} states, ${evals.length} evals)`); process.exit(0);
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
console.log(`wrote ${outPath}: ${total.toFixed(1)}s (${WARP ? "variable speed" : "real time"}), ${states.length} page states, scores ${evals.map((e) => e.score).join(" → ")}`);
