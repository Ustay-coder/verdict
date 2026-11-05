// A plain, effect-free "working video": Claude Code on the left, the landing page it edits on the right.
// Left: the recorded terminal bytes, replayed at their recorded times. Right: landing.md rendered as a page,
// re-rendered at the exact moment each Edit landed (tool-result timestamps aligned to the cast). Real time, 1×.
// No captions, overlays, highlights or sound. If a change lands outside the visible part of the preview, the preview
// jumps to it, as an editor's live preview does.
//   python3 build_edit_data.py <take-dir> ../v1.md ../../../rubrics/landing-page.yaml data.json
//   node plain2pane.mjs data.json out.mp4 [--from 10] [--tail 2.5] [--still sec out.png]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "node_modules"); // npm i @xterm/xterm@5.5.0 marked@12.0.2 in this folder
const [dataPath, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const fps = 30, FROM = Number(opt("from", 10)), TAIL = Number(opt("tail", 2.5));
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;
const D = JSON.parse(readFileSync(dataPath, "utf8"));
const doneSrc = D.cast.at(-1)[0];
const END = Math.min(doneSrc, Number(opt("end", 141))) + TAIL;
const total = END - FROM;

const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8");
const xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const markedJs = readFileSync(join(mods, "marked/lib/marked.umd.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;width:1920px;height:1080px;background:#1c1c1e;overflow:hidden;font-family:Inter,sans-serif}
.win{position:absolute;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #3a3a3e}
.bar{height:34px;line-height:34px;padding:0 14px;font:500 14px Inter;color:#9a9aa2;background:#2a2a2d}
#tw{left:24px;top:198px;width:1040px;height:684px;background:#141414}
#term{padding:12px 14px}
#pw{left:1088px;top:24px;width:808px;height:1032px;background:#fff}
#pv{position:absolute;top:34px;left:0;right:0;bottom:0;overflow:hidden;padding:28px 40px;color:#16161a;font:16px/1.55 Inter,sans-serif}
#pv h1{font:800 34px/1.15 "Inter Display",Inter;margin:.1em 0 .4em} #pv h2{font:700 22px/1.25 Inter;margin:1.1em 0 .4em} #pv h3{font:700 18px/1.3 Inter;margin:1em 0 .35em}
#pv p,#pv li{margin:.35em 0} #pv ul{padding-left:1.2em}
#pv pre{background:#16161a;color:#e6e6ea;border-radius:6px;padding:10px 12px;font:12.5px/1.45 "JetBrains Mono",monospace;white-space:pre-wrap;word-break:break-all}
#pv code{font-family:"JetBrains Mono",monospace;font-size:.88em;background:#f1f1f4;padding:.05em .3em;border-radius:4px} #pv pre code{background:none;padding:0}
#pv blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid #d0d0d8;color:#555}
#pv table{border-collapse:collapse;font-size:15px} #pv td,#pv th{border:1px solid #ddd;padding:3px 8px} #pv a{color:#1f5fd6}
</style></head><body>
<div class="win" id="tw"><div class="bar">claude — ~/verdict-landing</div><div id="term"></div></div>
<div class="win" id="pw"><div class="bar">landing.md — live preview</div><div id="pv"></div></div>
<script>window.D=${J({ cast: D.cast, states: D.states.map((s) => ({ src: s.src, md: s.md })) })};</script>
<script>${xtermJs}</script><script>${markedJs}</script>
<script>
const D=window.D;
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono",monospace',fontSize:16.8,lineHeight:1.2,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open(document.getElementById("term"));
let ci=0; window.feedTo=async(src)=>{let s="";while(ci<D.cast.length&&D.cast[ci][0]<=src) s+=D.cast[ci++][1]; if(s) await new Promise(r=>term.write(s,r));};
const pv=document.getElementById("pv");
const blocks=(md)=>marked.lexer(md).filter(t=>t.type!=="space").map(t=>({raw:t.raw.trim(),html:marked.parser([t])}));
const ST=D.states.map(s=>({...s,b:blocks(s.md)}));
let shown=-1;
window.showAt=(src)=>{
  let i=0; ST.forEach((s,k)=>{ if(s.src<=src) i=k; });
  if(i===shown) return; const prev=shown>=0?ST[shown]:null; shown=i;
  const keep=pv.scrollTop; pv.innerHTML=ST[i].b.map(b=>'<div data-raw>'+b.html+'</div>').join("");
  pv.scrollTop=keep;
  if(prev){ const had=new Set(prev.b.map(b=>b.raw)); const idx=ST[i].b.findIndex(b=>!had.has(b.raw));
    if(idx>=0){ const el=pv.children[idx]; const top=el.offsetTop, h=el.offsetHeight; if(top<pv.scrollTop||top+Math.min(h,200)>pv.scrollTop+pv.clientHeight) pv.scrollTop=Math.max(0,top-60); } }
};
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const step = async (src) => page.evaluate(async (src) => { await window.feedTo(src); window.showAt(src); }, src);

if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await step(FROM + v);
  await page.screenshot({ path: stillOut }); await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${total.toFixed(1)}s)`); process.exit(0);
}
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(total * fps);
for (let f = 0; f < frames; f++) {
  await step(FROM + f / fps);
  const img = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (fps * 10) === 0) process.stderr.write(`\r${(f / fps).toFixed(0)}s / ${total.toFixed(0)}s`);
}
ff.stdin.end(); await new Promise((r) => ff.on("close", r)); await browser.close();
console.log(`\nwrote ${outPath}: ${total.toFixed(1)}s real time (cast ${FROM}s → ${END.toFixed(1)}s)`);
