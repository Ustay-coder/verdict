// Plain, effect-free working video for an HTML page: Claude Code on the left, the page it edits on the right.
// Left: the recorded terminal bytes at their recorded times. Right: the real page (iframe, 1280 px wide like the
// renderer Verdict used, shown at 0.875×), reloaded at the exact moment each Edit/Write landed (tool-result
// timestamps aligned to the cast). Pages that fetch data.json get it from a routed virtual host; no port is opened.
// Real time, no captions, overlays, highlights or sound.
//   node plain2pane-html.mjs <take-dir> <states-dir> <data.json> out.mp4 [--from 10] [--tail 2.5] [--title t] [--url u] [--assets dir] [--still s out.png]
//   --assets: a folder whose files the page links by relative path (e.g. the work folder, for design-system/primer.css)
//   --warp w.json: variable speed instead of real time. { "coldOpen": { "seconds": 1.5, "label": "…" },
//     "segments": [[fromSec, toSec, speed], …] } in cast seconds. Waiting is compressed, moments that matter play slower,
//     and the current speed is printed above the terminal ("40× speed", "real time"). The optional cold open shows the
//     finished state first, then the run starts from the top. Nothing else is added.
//   take-dir: <name>.cast + <name>.cast.markers; states-dir: build_states.py output (timeline.json + states/NN.html)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const mods = [join(here, "node_modules"), join(here, "../render/node_modules")].find((m) => { try { readdirSync(join(m, "@xterm")); return true; } catch { return false; } });
const [takeDir, statesDir, dataJson, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const fps = 30, FROM = Number(opt("from", 10)), TAIL = Number(opt("tail", 2.5));
const TITLE = opt("title", "claude — ~/acme-dashboard-d"), URL_LABEL = opt("url", "127.0.0.1:8770 — index.html");
const ASSETS = opt("assets", null);
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;

const WARP = opt("warp", null) ? JSON.parse(readFileSync(opt("warp"), "utf8")) : null;
const castFile = readdirSync(takeDir).find((f) => f.endsWith(".cast"));
// Claude Code's header names the model and the plan; both are blanked (same width, so nothing else moves).
const redact = (s) => s.replace(/(Opus|Sonnet|Haiku|Fable) \d+(\.\d+)? · Claude (API|Max|Pro|Team|Enterprise)/g, (m) => " ".repeat(m.length));
const cast = readFileSync(join(takeDir, castFile), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === "o").map((e) => [e[0], redact(e[2])]);
const markers = Object.fromEntries(readFileSync(join(takeDir, castFile + ".markers"), "utf8").trim().split("\n").map((l) => l.split("\t")).map(([t, k]) => [k, Number(t)]));
const tl = JSON.parse(readFileSync(join(statesDir, "timeline.json"), "utf8"));
const states = tl.states.map((s) => ({ src: s.src, file: s.file.split("/").pop() }));
const END = (markers.done ?? cast.at(-1)[0]) + TAIL;
// Output timeline: [outStart, outEnd, srcFrom, srcTo, label] pieces.
const pieces = [];
{ let t = 0;
  if (WARP?.coldOpen) { pieces.push([0, WARP.coldOpen.seconds, END, END, WARP.coldOpen.label, true]); t = WARP.coldOpen.seconds; }
  for (const [a, b, sp] of WARP?.segments ?? [[FROM, END, 1]]) { const d = (b - a) / sp; pieces.push([t, t + d, a, b, WARP ? (sp === 1 ? "real time" : `${sp}× speed`) : "", false]); t += d; } }
const total = pieces.at(-1)[1];
const at = (t) => { const p = pieces.find((q) => t < q[1]) ?? pieces.at(-1); const k = p[1] > p[0] ? Math.min(1, (t - p[0]) / (p[1] - p[0])) : 0; return { src: p[2] + (p[3] - p[2]) * k, label: p[4], cold: p[5] }; };

const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8");
const xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const SCALE = 0.875, PW = 1280 * SCALE;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;width:1920px;height:1080px;background:#1c1c1e;overflow:hidden;font-family:Inter,sans-serif}
.win{position:absolute;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #3a3a3e}
.bar{height:32px;line-height:32px;padding:0 12px;font:500 13px Inter;color:#9a9aa2;background:#2a2a2d;white-space:nowrap;overflow:hidden}
#tw{left:20px;top:290px;width:${1920 - PW - 60}px;height:${32 + 16 + 30 * 12.2 * 1.2 + 8}px;background:#141414}
#term{padding:8px 10px}
#pw{left:${1920 - PW - 20}px;top:20px;width:${PW}px;height:1040px;background:#fff}
#chip{position:absolute;left:24px;top:252px;font:500 22px Inter;color:#9a9aa2}
#vp{position:absolute;top:32px;left:0;width:1280px;height:${(1040 - 32) / SCALE}px;transform:scale(${SCALE});transform-origin:0 0;border:0;background:#fff}
</style></head><body>
<div id="chip"></div><div class="win" id="tw"><div class="bar">${TITLE}</div><div id="term"></div></div>
<div class="win" id="pw"><div class="bar">${URL_LABEL}</div><iframe id="vp"></iframe></div>
<script>window.CAST=${J(cast)};</script><script>${xtermJs}</script>
<script>
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono",monospace',fontSize:12.2,lineHeight:1.2,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open(document.getElementById("term"));
let ci=0; window.resetTerm=()=>{term.reset();ci=0;}; window.chip=(t)=>{document.getElementById("chip").textContent=t;};
window.feedTo=async(src)=>{let s="";while(ci<CAST.length&&CAST[ci][0]<=src) s+=CAST[ci++][1]; if(s) await new Promise(r=>term.write(s,r));};
window.load=(u)=>new Promise((r)=>{const f=document.getElementById("vp"); f.onload=()=>r(); f.src=u;});
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await ctx.route("http://take.local/**", (route) => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const f = pathname.split("/").pop() || "index.html";
  if (ASSETS && pathname.split("/").length > 2) return route.fulfill({ path: join(ASSETS, pathname), contentType: f.endsWith(".css") ? "text/css" : f.endsWith(".png") ? "image/png" : undefined });
  const path = f === "data.json" ? dataJson : join(statesDir, "states", f);
  return route.fulfill({ path, contentType: f.endsWith(".json") ? "application/json" : "text/html" });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
let shown = -1, wasCold = false;
async function step(src) {
  await page.evaluate((s) => window.feedTo(s), src);
  let i = 0; states.forEach((s, k) => { if (s.src <= src) i = k; });
  if (i !== shown) {
    shown = i;
    await page.evaluate((u) => window.load(u), `http://take.local/${states[i].file}`);
    await page.waitForTimeout(i === 0 ? 3000 : 600); // first page has been open a while; later reloads settle (data.json fetch)
  }
}

async function frame(t) {
  const a = at(t);
  if (wasCold && !a.cold) { await page.evaluate(() => window.resetTerm()); shown = -1; } // cold open over: start from the top
  wasCold = a.cold;
  await step(a.src);
  await page.evaluate((l) => window.chip(l), a.label);
}
if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await frame(v);
  await page.screenshot({ path: stillOut }); await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${total.toFixed(1)}s, ${states.length} states)`); process.exit(0);
}
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(total * fps);
for (let f = 0; f < frames; f++) {
  await frame(f / fps);
  const img = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (fps * 15) === 0) process.stderr.write(`\r${(f / fps).toFixed(0)}s / ${total.toFixed(0)}s`);
}
ff.stdin.end(); await new Promise((r) => ff.on("close", r)); await browser.close();
console.log(`\nwrote ${outPath}: ${total.toFixed(1)}s (${WARP ? "variable speed" : "real time"}, cast ${(WARP?.segments?.[0]?.[0] ?? FROM)}s → ${END.toFixed(1)}s), ${states.length} page states`);
