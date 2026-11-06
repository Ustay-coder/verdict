// Plain working video for `verdict watch`: Claude Code on the left, the live results page on the right.
// Left: the recorded terminal bytes at their recorded times. Right: the real `verdict watch` page (the CLI's own HTML and
// watchState), fed the evaluation store as it was at each moment of the recording (snapshot.py versions, aligned to
// the cast through the session transcript). The page polls like it does live; the renderer also asks it to refresh
// whenever the store changed, and lets its own row animations play in real time.
//   node plain2pane-watch.mjs <take-dir> <snap-dir> out.mp4 [--warp w.json] [--title t] [--url u] [--layout wide|vertical] [--lang en|ko] [--still s out.png]
//   --layout vertical: 1080×1920 for Reels/Shorts, the watch page on top and the terminal below
//   take-dir: <name>.cast + .cast.markers + session.jsonl (record.py); snap-dir: snapshot.py output
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const { watchState, watchPage } = await import(pathToFileURL(join(here, "../../../packages/cli/dist/watch.js")).href);

const [takeDir, snapDir, outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const mods = [process.env.XTERM_MODULES, join(here, "node_modules")].filter(Boolean).find((m) => { try { readdirSync(join(m, "@xterm")); return true; } catch { return false; } });
const fps = 30, TAIL = 2.5;
const TITLE = opt("title", "claude"), URL_LABEL = opt("url", "127.0.0.1:4600 — verdict watch");
const KO = opt("lang", "en") === "ko"; // speed labels in Korean ("40배속", "실제 속도")
const WARP = opt("warp", null) ? JSON.parse(readFileSync(opt("warp"), "utf8")) : null;
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;

const castFile = readdirSync(takeDir).find((f) => f.endsWith(".cast"));
// Claude Code's header names the model and the plan; both are blanked (same width, so nothing else moves).
const redact = (s) => s.replace(/(Opus|Sonnet|Haiku|Fable) \d+(\.\d+)? · Claude (API|Max|Pro|Team|Enterprise)/g, (m) => " ".repeat(m.length));
const cast = readFileSync(join(takeDir, castFile), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l)).filter((e) => e[1] === "o").map((e) => [e[0], redact(e[2])]);
const markers = Object.fromEntries(readFileSync(join(takeDir, castFile + ".markers"), "utf8").trim().split("\n").map((l) => l.split("\t")).map(([t, k]) => [k, Number(t)]));
// Wall clock → cast time: the transcript's first user message is the prompt submit (as in build_states.py).
const t0 = (() => { for (const l of readFileSync(join(takeDir, "session.jsonl"), "utf8").split("\n")) { if (!l) continue; const e = JSON.parse(l); if (e.type === "user" && typeof e.message?.content === "string") return Date.parse(e.timestamp) / 1000; } throw new Error("no prompt in session.jsonl"); })();
const snaps = readdirSync(snapDir).filter((f) => f.includes("__")).map((f) => ({ cast: Number(f.split("__")[0]) - t0 + markers.submitted, id: f.split("__")[1], file: join(snapDir, f) })).sort((a, b) => a.cast - b.cast);
const docs = new Map(); // file -> parsed (lazy)
const storeAt = (src) => { const latest = new Map(); for (const s of snaps) if (s.cast <= src) latest.set(s.id, s); return latest; };

const END = (markers.done ?? cast.at(-1)[0]) + TAIL, FROM = Number(opt("from", markers.submitted - 0.5));
const pieces = []; { let t = 0;
  if (WARP?.coldOpen) { pieces.push([0, WARP.coldOpen.seconds, END, END, WARP.coldOpen.label, true]); t = WARP.coldOpen.seconds; }
  for (const [a, b, sp] of WARP?.segments ?? [[FROM, END, 1]]) { const d = (b - a) / sp; pieces.push([t, t + d, a, b, WARP ? (KO ? (sp === 1 ? "실제 속도" : `${sp}배속`) : (sp === 1 ? "real time" : `${sp}× speed`)) : "", false]); t += d; } }
const total = pieces.at(-1)[1];
const at = (t) => { const p = pieces.find((q) => t < q[1]) ?? pieces.at(-1); const k = p[1] > p[0] ? Math.min(1, (t - p[0]) / (p[1] - p[0])) : 0; return { src: p[2] + (p[3] - p[2]) * k, label: p[4], cold: p[5] }; };

const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8"), xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const VERT = opt("layout", "wide") === "vertical";
const VW = VERT ? 1080 : 1920, VH = VERT ? 1920 : 1080;
const SCALE = VERT ? 1040 / 1280 : 0.875, PW = 1280 * SCALE;
const TFS = VERT ? 16.4 : 12.2, TH = 32 + 16 + 30 * TFS * 1.2 + 8; // terminal: 100×30 cells
const GEO = VERT
  ? { tw: `left:20px;top:${VH - TH - 20}px;width:${VW - 40}px;height:${TH}px`, pw: `left:20px;top:20px;width:${PW}px;height:${VH - TH - 100}px`,
      chip: `left:24px;top:${VH - TH - 62}px`, vpH: (VH - TH - 100 - 32) / SCALE }
  : { tw: `left:20px;top:290px;width:${1920 - PW - 60}px;height:${TH}px`, pw: `left:${1920 - PW - 20}px;top:20px;width:${PW}px;height:1040px`,
      chip: "left:24px;top:252px", vpH: (1040 - 32) / SCALE };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;width:${VW}px;height:${VH}px;background:#1c1c1e;overflow:hidden;font-family:Inter,sans-serif}
.win{position:absolute;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #3a3a3e}
.bar{height:32px;line-height:32px;padding:0 12px;font:500 13px Inter;color:#9a9aa2;background:#2a2a2d;white-space:nowrap;overflow:hidden}
#tw{${GEO.tw};background:#141414}#term{padding:8px 10px}
#pw{${GEO.pw};background:#f6f7f9}
#chip{position:absolute;${GEO.chip};font:500 22px Inter,NanumGothic;color:#9a9aa2}
#vp{position:absolute;top:32px;left:0;width:1280px;height:${GEO.vpH}px;transform:scale(${SCALE});transform-origin:0 0;border:0;background:#f6f7f9}
</style></head><body><div id="chip"></div>
<div class="win" id="tw"><div class="bar">${TITLE}</div><div id="term"></div></div>
<div class="win" id="pw"><div class="bar">${URL_LABEL}</div><iframe id="vp" src="http://watch.local/"></iframe></div>
<script>window.CAST=${J(cast)};</script><script>${xtermJs}</script><script>
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono","NanumGothicCoding",monospace',fontSize:${TFS},lineHeight:1.2,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open(document.getElementById("term"));
let ci=0; window.resetTerm=()=>{term.reset();ci=0;}; window.chip=(t)=>{document.getElementById("chip").textContent=t;};
window.feedTo=async(src)=>{let s="";while(ci<CAST.length&&CAST[ci][0]<=src) s+=CAST[ci++][1]; if(s) await new Promise(r=>term.write(s,r));};
</script></body></html>`;

let current = new Map();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, timezoneId: "UTC" });
await ctx.route("http://watch.local/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith("/api/state")) {
    const evs = [...current.values()].map((s) => { if (!docs.has(s.file)) docs.set(s.file, JSON.parse(readFileSync(s.file, "utf8"))); return docs.get(s.file); });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(watchState(evs)) });
  }
  return route.fulfill({ contentType: "text/html", body: watchPage(opt("source", "~/" + TITLE.split("~/")[1] + "/.verdict")) });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const watch = () => page.frames().find((f) => f.url().startsWith("http://watch.local"));
let key = "", wasCold = false, settle = 0;
async function frame(t) {
  const a = at(t);
  if (wasCold && !a.cold) { await page.evaluate(() => window.resetTerm()); key = ""; }
  wasCold = a.cold;
  await page.evaluate((s) => window.feedTo(s), a.src);
  current = storeAt(a.src);
  const k = [...current.values()].map((s) => s.file).join("|");
  if (k !== key) { key = k; await watch().evaluate(() => window.verdictWatchRefresh()); settle = 26; }
  await page.evaluate((l) => window.chip(l), a.label);
  if (settle > 0) { settle--; await page.waitForTimeout(1000 / fps); } // the page's own transitions play at their speed
}
if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await frame(v);
  await page.waitForTimeout(900); await page.screenshot({ path: stillOut }); await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${total.toFixed(1)}s, ${snaps.length} snapshots)`); process.exit(0);
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
console.log(`wrote ${outPath}: ${total.toFixed(1)}s (${WARP ? "variable speed" : "real time"}), ${snaps.length} store snapshots`);
