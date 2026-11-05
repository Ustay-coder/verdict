// Final edit of the "15 → 94" video. Everything on screen is driven by data.json (built from Take A's real artifacts):
// the terminal replays the recorded bytes, the preview renders landing.md exactly as it was at that moment,
// the score card shows the agent's own evaluate results. Frames are captured deterministically and piped to ffmpeg.
//
//   python3 build_edit_data.py <take-dir> ../v1.md ../../../rubrics/landing-page.yaml data.json
//   node edit.mjs data.json out.mp4 [--still <sec> out.png] [--fps 30]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "node_modules");   // npm i @xterm/xterm@5.5.0 marked@12.0.2 in this folder
const [dataPath, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const fps = Number(opt("fps", 30));
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;
const data = JSON.parse(readFileSync(dataPath, "utf8"));

// ---- timeline (video seconds) ----
const T = { introA: 0, introB: 2.3, yaml: 5.3, split: 8.3 };
let acc = 0;
const segs = data.segments.map(([a, b, sp]) => { const s = { a, b, sp, v0: T.split + acc }; acc += (b - a) / sp; s.v1 = T.split + acc; return s; });
T.board = T.split + acc + 0.3;
T.honest = T.board + 5.5;
T.end = T.honest + 3.6;
T.total = T.end + 3.8;

const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8");
const xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const markedJs = readFileSync(join(mods, "marked/lib/marked.umd.js"), "utf8");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
:root{--bg:#0c0c0e;--panel:#151518;--line:#2a2a30;--fg:#ececf1;--mut:#8b8b96;--acc:#4ade80;--red:#f05252;--amb:#f5b841}
*{box-sizing:border-box}
html,body{margin:0;width:1920px;height:1080px;background:var(--bg);overflow:hidden;font-family:Inter,sans-serif;color:var(--fg)}
.layer{position:absolute;inset:0;opacity:0}
/* page look (used by intro + live preview) */
.page{background:#fff;color:#16161a;font-family:Inter,sans-serif;line-height:1.5}
.page h1{font:800 1.9em/1.15 "Inter Display",Inter,sans-serif;margin:.2em 0 .35em}
.page h2{font:700 1.3em/1.25 "Inter Display",Inter,sans-serif;margin:.9em 0 .35em}
.page h3{font:700 1.05em/1.3 Inter,sans-serif;margin:.9em 0 .3em}
.page p,.page li{margin:.3em 0}
.page ul{padding-left:1.2em;margin:.3em 0}
.page pre{background:#16161a;color:#e6e6ea;border-radius:8px;padding:.7em .9em;font:0.78em/1.45 "JetBrains Mono",monospace;white-space:pre-wrap;word-break:break-all;margin:.5em 0}
.page code{font-family:"JetBrains Mono",monospace;font-size:.88em;background:#f1f1f4;padding:.05em .3em;border-radius:4px}
.page pre code{background:none;padding:0;font-size:1em}
.page blockquote{margin:.5em 0;padding:.2em .8em;border-left:3px solid #d0d0d8;color:#555}
.page table{border-collapse:collapse;font-size:.9em;margin:.5em 0}.page td,.page th{border:1px solid #ddd;padding:.2em .5em}
.page a{color:#1f5fd6}
.blk{border-radius:6px;transition:none;margin:0 -.4em;padding:0 .4em}
.blk.del{background:rgba(240,82,82,.22);text-decoration:line-through;text-decoration-color:rgba(200,30,30,.8)}
.blk.add{background:rgba(74,222,128,calc(var(--a)*.38));box-shadow:inset 3px 0 0 rgba(22,163,74,var(--a))}
mark.bz{background:transparent;color:inherit;border-radius:4px;padding:0 .1em}
mark.bz.on{background:#ffe066;box-shadow:0 0 0 2px #ffe066}
/* intro */
#introPage{position:absolute;left:50%;top:60px;width:1180px;margin-left:-590px;height:850px;border-radius:18px;padding:56px 80px;font-size:25px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 78%,transparent)}
#stamp{position:absolute;right:120px;top:120px;border:10px solid var(--red);color:var(--red);font:900 120px/1 "Inter Display",Inter;padding:18px 34px;border-radius:22px;transform:rotate(-9deg);background:rgba(255,255,255,.85);opacity:0}
#bzCount{position:absolute;right:120px;top:120px;font:800 54px/1 "Inter Display";color:#16161a;background:#ffe066;padding:16px 26px;border-radius:16px;opacity:0}
#yamlCard{position:absolute;left:50%;top:150px;width:1400px;margin-left:-700px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:40px 50px;font:26px/1.55 "JetBrains Mono",monospace;white-space:pre;color:#9a9aa6}
#yamlBody div{overflow:hidden;text-overflow:ellipsis}#yamlCard{overflow:hidden}#yamlCard .lv{color:#9a9aa6}#yamlCard .lv.on{color:#fff}#yamlCard .lv.on .lab{color:var(--acc)}
#yamlTitle{font:600 22px Inter;color:var(--mut);margin-bottom:18px;letter-spacing:.06em;text-transform:uppercase}
/* split */
#term{position:absolute;left:44px;top:60px;width:1090px;height:820px;background:#141414;border:1px solid var(--line);border-radius:14px;padding:22px 18px;overflow:hidden}
#termHead,#prevHead{position:absolute;top:22px;font:600 16px "JetBrains Mono";color:var(--mut);letter-spacing:.04em}
#termHead{left:56px}#prevHead{left:1166px}
#speed{position:absolute;left:1040px;top:18px;font:700 15px "JetBrains Mono";color:#111;background:var(--amb);padding:4px 9px;border-radius:6px}
#card{position:absolute;left:1162px;top:60px;width:714px;height:300px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 26px}
#score{font:800 112px/1 "Inter Display";letter-spacing:-.02em}
#grade{font:700 24px Inter;margin-left:14px;vertical-align:top;position:relative;top:14px;padding:4px 12px;border-radius:8px}
#scoreRow{display:flex;align-items:flex-start;gap:6px}
#scoreSub{font:500 17px/1.35 Inter;color:var(--mut);margin-top:8px;max-width:285px}
#bars{position:absolute;left:330px;top:22px;right:24px}
.bar{display:grid;grid-template-columns:118px 1fr 44px;align-items:center;gap:10px;height:35px;font:500 16px Inter;color:#c9c9d2}
.bar .tr{height:12px;background:#24242a;border-radius:6px;overflow:hidden}.bar .fl{height:100%;border-radius:6px;background:#6b6b78}
.bar .pc{text-align:right;font:600 15px "JetBrains Mono";color:#c9c9d2}
.bar.next .nm{color:var(--amb)}.bar.next .fl{background:var(--amb)}
.bar.next .nm::before{content:"▸ ";color:var(--amb)}
#nextTag{position:absolute;left:1189px;top:300px;font:600 16px Inter;color:var(--amb)}
#prev{position:absolute;left:1162px;top:380px;width:714px;height:500px;border-radius:14px;overflow:hidden;border:1px solid var(--line)}
#prevBody{position:absolute;inset:0;overflow:hidden;padding:26px 34px;font-size:17px}
/* outro */
#boardWrap{position:absolute;left:50%;top:120px;width:1400px;margin-left:-700px}
#boardTitle{font:600 22px Inter;color:var(--mut);letter-spacing:.06em;text-transform:uppercase;margin-bottom:26px}
.brow{display:grid;grid-template-columns:330px 1fr 110px 140px;align-items:center;gap:18px;height:84px;font:600 28px Inter}
.brow .lbl{color:#d6d6de}.brow .lbl span{color:var(--mut);font-weight:500;font-family:"JetBrains Mono";font-size:22px}
.brow .tr{height:34px;background:#1d1d22;border-radius:9px;overflow:hidden}.brow .fl{height:100%;border-radius:9px}
.brow .num{font:800 44px "Inter Display";text-align:right}.brow .gr{font:600 20px Inter;color:var(--mut)}
#quote{position:absolute;left:50%;top:250px;width:1500px;margin-left:-750px;text-align:center;font:600 54px/1.35 Inter;color:#16161a;background:#fff;border-radius:18px;padding:50px 60px}
#quote u{text-decoration:underline wavy var(--red) 4px;text-underline-offset:10px}
#quoteSrc{position:absolute;left:50%;top:190px;transform:translateX(-50%);font:600 20px "JetBrains Mono";color:var(--mut)}
#endWrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
#word{font:800 150px/1 "JetBrains Mono";letter-spacing:-.03em}
#tag{font:600 48px Inter}
#small{font:500 28px Inter;color:var(--mut)}
#disc{position:absolute;bottom:34px;left:0;right:0;text-align:center;font:500 19px Inter;color:#6f6f7a}
/* captions */
#cap{position:absolute;left:0;right:0;bottom:44px;text-align:center;pointer-events:none}
#capMain{display:inline-block;font:700 46px/1.2 Inter;color:#fff;background:rgba(10,10,12,.82);padding:12px 26px;border-radius:14px;max-width:1700px}
#capSub{display:block;margin-top:10px;font:700 34px "JetBrains Mono";color:var(--acc)}
#capSub:empty{display:none}
</style></head><body>
<div id="L_intro" class="layer"><div id="introPage" class="page"></div><div id="stamp">15/100</div><div id="bzCount"></div></div>
<div id="L_yaml" class="layer"><div id="yamlCard"><div id="yamlTitle">examples/rubrics/landing-page.yaml</div><div id="yamlBody"></div></div></div>
<div id="L_split" class="layer">
  <div id="termHead">claude code · real run</div><div id="speed"></div><div id="term"><div id="xt"></div></div>
  <div id="card"><div id="scoreRow"><div id="score">—</div><div id="grade"></div></div><div id="scoreSub">waiting for the first evaluation</div><div id="bars"></div></div><div id="nextTag"></div>
  <div id="prevHead"></div>
  <div id="prev" class="page"><div id="prevBody"></div></div>
</div>
<div id="L_board" class="layer"><div id="boardWrap"><div id="boardTitle">Score history · one unattended run</div><div id="board"></div></div></div>
<div id="L_honest" class="layer"><div id="quoteSrc">landing.md (final, 94/100), line 14</div><div id="quote">“Our <u>proprietary AI</u> understands your content like never before.”</div></div>
<div id="L_end" class="layer"><div id="endWrap"><div id="word">verdict</div><div id="tag">Your taste, as YAML. Your agent, as the editor.</div><div id="small">Rubric, all 7 drafts and the scores in the replies ↓</div></div>
  <div id="disc">Real, unattended Claude Code run · waiting time sped up · scores by Verdict (Jev + Clef-flash)</div></div>
<div id="cap"><span id="capMain"></span><span id="capSub"></span></div>
<script>window.DATA=${J(data)};window.TL=${J(T)};window.SEGS=${J(segs)};</script><script>${xtermJs}</script><script>${markedJs}</script>
<script>
const D = window.DATA, T = window.TL, SEGS = window.SEGS;
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const fade = (v, a, b, f = 0.3) => clamp(Math.min((v - a) / f, (b - v) / f));
const GRADE = { "rewrite": ["#3a3a42", "#d6d6de"], "almost": ["#5a4410", "#f5b841"], "ship it": ["#0f3d22", "#4ade80"] };

// ---- source <-> video ----
function srcAt(v) { for (const s of SEGS) if (v <= s.v1) return s.a + Math.max(0, v - s.v0) * s.sp; return SEGS[SEGS.length - 1].b; }
function vidAt(src) { for (const s of SEGS) if (src <= s.b) return s.v0 + Math.max(0, src - s.a) / s.sp; return SEGS[SEGS.length - 1].v1; }
function speedAt(v) { for (const s of SEGS) if (v <= s.v1) return s.sp; return 1; }

// ---- markdown blocks ----
function blocks(md) { return marked.lexer(md).filter(t => t.type !== "space").map(t => ({ raw: t.raw.trim(), html: marked.parser([t]) })); }
const STATES = D.states.map(s => ({ ...s, v: vidAt(s.src), blocks: blocks(s.md) }));
const EVALS = D.evals.map(e => ({ ...e, v: vidAt(e.src) }));

// ---- intro page with buzzword marks (the rubric's own regex) ----
(function intro() {
  const el = $("introPage"); el.innerHTML = STATES[0].blocks.map(b => b.html).join("");
  const re = new RegExp(D.buzzwordPattern, "gi"); let k = 0;
  const walk = (n) => { for (const c of [...n.childNodes]) { if (c.nodeType === 3) {
      const t = c.textContent; if (!re.test(t)) continue; re.lastIndex = 0;
      const frag = document.createDocumentFragment(); let last = 0, m;
      while ((m = re.exec(t))) { frag.append(t.slice(last, m.index)); const mk = document.createElement("mark"); mk.className = "bz"; mk.dataset.i = k++; mk.textContent = m[0]; frag.append(mk); last = m.index + m[0].length; }
      frag.append(t.slice(last)); c.replaceWith(frag);
    } else walk(c); } };
  walk(el); window.BZ = k;
})();
$("yamlBody").innerHTML = D.rubricLevels.split("\\n").map(l => {
  const m = l.match(/label: (\\w+)/); const esc = l.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return m ? '<div class="lv" data-l="' + m[1] + '">' + esc.replace("label: " + m[1], 'label: <span class="lab">' + m[1] + "</span>") + "</div>" : "<div>" + esc + "</div>";
}).join("");

// ---- terminal ----
const term = new Terminal({ cols: 100, rows: 30, fontFamily: '"JetBrains Mono", monospace', fontSize: 17.4, lineHeight: 1.1, scrollback: 0,
  cursorBlink: false, allowProposedApi: true, theme: { background: "#141414", foreground: "#e6e6e6", cursor: "#141414" } });
term.open($("xt"));
let castIdx = 0;
async function feedTo(src) { let s = ""; while (castIdx < D.cast.length && D.cast[castIdx][0] <= src) s += D.cast[castIdx++][1]; if (s) await new Promise(r => term.write(s, r)); }

// ---- score card ----
const CRIT = [["value_prop", "Five-second"], ["proof", "Proof"], ["time_to_value", "Time to value"], ["specificity", "Specificity"], ["cta", "One CTA"], ["install_cmd", "Install cmd"], ["hype_free", "No hype"]];
$("bars").innerHTML = CRIT.map(([id, nm]) => '<div class="bar" id="b_' + id + '"><div class="nm">' + nm + '</div><div class="tr"><div class="fl"></div></div><div class="pc"></div></div>').join("");
function card(v) {
  let i = -1; EVALS.forEach((e, k) => { if (e.v <= v) i = k; });
  if (i < 0) return;
  const e = EVALS[i], p = EVALS[i - 1], a = ease((v - e.v) / 0.7);
  const sc = p ? p.score + (e.score - p.score) * a : e.score * a;
  $("score").textContent = Math.round(sc);
  const g = GRADE[e.grade] || GRADE.rewrite; $("grade").textContent = e.grade; $("grade").style.background = g[0]; $("grade").style.color = g[1];
  $("scoreSub").textContent = i === 0 ? "baseline · evaluation 1 of 7" : "after fix " + i + " · " + e.fixed + " · evaluation " + (i + 1) + " of 7";
  const next = EVALS[i + 1] ? EVALS[i + 1].fixed : null;
  $("nextTag").textContent = next ? "▸ next fix: " + (CRIT.find(c => c[0] === next) || [0, next])[1] : "";
  for (const [id] of CRIT) {
    const n = (x) => (x && x.criteria.find(c => c.id === id) || { n: 0 }).n;
    const val = p ? n(p) + (n(e) - n(p)) * a : n(e) * a, el = $("b_" + id);
    el.querySelector(".fl").style.width = (val * 100).toFixed(1) + "%"; el.querySelector(".pc").textContent = Math.round(val * 100) + "%";
    el.classList.toggle("next", id === next);
    el.querySelector(".fl").style.background = id === next ? "" : (val >= .85 ? "#4ade80" : val >= .5 ? "#a3a3ae" : "#6b6b78");
  }
}

// ---- live preview ----
let shown = null, scroll = { from: 0, to: 0, at: 0, cur: 0 };
function preview(v) {
  let i = 0; STATES.forEach((s, k) => { if (k > 0 && s.v <= v) i = k; });
  const s = STATES[i], prev = STATES[i - 1], phaseA = i > 0 && v < s.v + 0.45;
  const key = i + (phaseA ? "a" : "b");
  const body = $("prevBody");
  if (shown !== key) {
    shown = key;
    if (phaseA) { const keep = new Set(s.blocks.map(b => b.raw)); body.innerHTML = prev.blocks.map(b => '<div class="blk' + (keep.has(b.raw) ? "" : " del") + '">' + b.html + "</div>").join(""); }
    else { const had = new Set(prev ? prev.blocks.map(b => b.raw) : []); body.innerHTML = s.blocks.map(b => '<div class="blk' + (i > 0 && !had.has(b.raw) ? " add" : "") + '">' + b.html + "</div>").join(""); }
    const tgt = body.querySelector(phaseA ? ".del" : ".add");
    const max = Math.max(0, body.scrollHeight - body.clientHeight);
    scroll = { from: scroll.cur, to: tgt ? clamp(tgt.offsetTop - 70, 0, max) : clamp(scroll.cur, 0, max), at: v };
  }
  const a = phaseA ? 1 : clamp(1 - (v - s.v - 0.45) / 2.4);
  body.style.setProperty("--a", a.toFixed(3));
  scroll.cur = scroll.from + (scroll.to - scroll.from) * ease((v - scroll.at) / 0.4);
  body.scrollTop = scroll.cur;
  $("prevHead").textContent = "landing.md · live preview of the agent's file" + (i ? " · edit " + i + "/7" : "");
}

// ---- captions ----
const FIX = { cta: "4 buttons → 1 link", install_cmd: "add a way to try it", hype_free: "delete the hype", proof: "show real output", time_to_value: "one command to a first result", value_prop: "a headline that says what it is" };
const CAPS = [
  [0.1, T.introB, "Our landing page scored 15/100.", ""],
  [T.introB + 0.1, T.yaml, "12 buzzwords. 0 lines of code.", ""],
  [T.yaml + 0.1, T.split, "So we wrote down what “good” means. In YAML.", ""],
  [T.split + 0.2, EVALS[0].v - 0.2, "Then we gave an agent one rule:", "fix only the weakest thing · re-score · repeat"],
  [EVALS[0].v, STATES[1].v - 0.05, "Baseline: 15. Every criterion scored, with how sure it is.", ""],
];
for (let k = 1; k < EVALS.length; k++) {
  const e = EVALS[k], p = EVALS[k - 1];
  const edit = STATES.find(s => s.v > p.v);
  const end = k + 1 < EVALS.length ? STATES.find(s => s.v > e.v).v - 0.05 : e.v + 3.0;
  const extra = e.score === 88 ? " · passes, but the goal is 90" : e.grade === "ship it" && k === EVALS.length - 1 ? " · ship it" : "";
  CAPS.push([edit.v, e.v, "Fix " + k + " · " + FIX[e.fixed], ""]);
  CAPS.push([e.v, end, "Fix " + k + " · " + FIX[e.fixed], "+" + (e.score - p.score) + " → " + e.score + extra]);
}
const lastE = EVALS[EVALS.length - 1];
CAPS.push([lastE.v + 3.0, T.board, "94. One score went down on the way.", "specificity 78% → 66%"]);
CAPS.push([T.board + 0.2, T.honest, "6 rewrites. 1 criterion each.", "under 2 minutes · unattended"]);
CAPS.push([T.honest + 0.2, T.end, "It still says “proprietary AI”. That isn't true.", "the rubric never checked claims · that's the next rubric"]);
function caption(v) {
  const c = CAPS.find(([a, b]) => v >= a && v < b);
  $("cap").style.opacity = c ? fade(v, c[0], c[1], 0.15).toFixed(3) : 0;
  if (c) { if ($("capMain").textContent !== c[2]) $("capMain").textContent = c[2]; $("capSub").textContent = c[3]; }
}

// ---- scenes ----
function board(v) {
  const el = $("board");
  if (!el.dataset.ok) {
    el.innerHTML = EVALS.map((e, k) => '<div class="brow" id="r' + k + '"><div class="lbl">' + (k === 0 ? "start <span>(v1)</span>" : "fix " + k + " <span>" + e.fixed + "</span>") + '</div><div class="tr"><div class="fl"></div></div><div class="num"></div><div class="gr">' + e.grade + "</div></div>").join("");
    el.dataset.ok = 1;
  }
  EVALS.forEach((e, k) => {
    const a = ease((v - T.board - 0.3 - k * 0.32) / 0.5), r = $("r" + k);
    r.style.opacity = clamp(a * 3); r.querySelector(".fl").style.width = (e.score * a) + "%";
    r.querySelector(".fl").style.background = (GRADE[e.grade] || GRADE.rewrite)[1];
    r.querySelector(".num").textContent = Math.round(e.score * a);
  });
}
window.setTime = async (v) => {
  const L = { intro: fade(v, -1, T.yaml), yaml: fade(v, T.yaml, T.split), split: fade(v, T.split, T.board), board: fade(v, T.board, T.honest), honest: fade(v, T.honest, T.end), end: fade(v, T.end, T.total + 1) };
  for (const k in L) $("L_" + k).style.opacity = L[k].toFixed(3);
  if (v < T.yaml) {
    const st = ease((v - 0.15) / 0.25); $("stamp").style.opacity = v < T.introB ? clamp(st * 2) : clamp(1 - (v - T.introB) / 0.3);
    $("stamp").style.transform = "rotate(-9deg) scale(" + (1.7 - 0.7 * st).toFixed(3) + ")";
    const on = v < T.introB ? 0 : Math.floor((v - T.introB - 0.3) / 0.2) + 1;
    document.querySelectorAll("mark.bz").forEach(m => m.classList.toggle("on", Number(m.dataset.i) < on));
    $("bzCount").style.opacity = v > T.introB + 0.3 ? 1 : 0; $("bzCount").textContent = Math.min(Math.max(on, 0), window.BZ) + " buzzwords";
  }
  if (v >= T.yaml && v < T.split) {
    const order = ["fog", "category", "what", "what_who", "sharp"], on = Math.floor((v - T.yaml - 0.4) / 0.42);
    document.querySelectorAll("#yamlCard .lv").forEach(el => el.classList.toggle("on", order.indexOf(el.dataset.l) <= on));
  }
  if (v >= T.split - 0.3 && v < T.board + 0.3) {
    await feedTo(v < T.split ? 12.3 : srcAt(v));
    const sp = speedAt(v); $("speed").textContent = v >= T.split && sp > 1.5 ? "▶▶ " + Math.round(sp) + "×" : ""; $("speed").style.display = $("speed").textContent ? "" : "none";
    card(v); preview(v);
  }
  if (v >= T.board - 0.3) board(v);
  caption(v);
};
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await page.evaluate((v) => window.setTime(v), v);
  await page.screenshot({ path: stillOut });
  await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${T.total.toFixed(1)}s)`);
  process.exit(0);
}

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(T.total * fps);
for (let f = 0; f < frames; f++) {
  await page.evaluate((v) => window.setTime(v), f / fps);
  const img = await page.screenshot({ type: "jpeg", quality: 93 });
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (fps * 5) === 0) process.stderr.write(`\r${(f / fps).toFixed(0)}s / ${T.total.toFixed(0)}s`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`\nwrote ${outPath}: ${T.total.toFixed(1)}s`);
console.log(JSON.stringify({ split: T.split, board: T.board, honest: T.honest, end: T.end, edits: data.states.slice(1).map(s => s.src), evals: data.evals.map(e => e.src) }));
