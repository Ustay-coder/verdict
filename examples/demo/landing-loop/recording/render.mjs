// Render an asciicast v2 recording (from record.py) to MP4 by replaying the exact bytes through xterm.js and capturing frames.
//
//   node render.mjs <in.cast> <out.mp4> [--fps 30] [--fast 8] [--cap 1] [--from s] [--to s] [--still s out.png]
//
// Timeline: busy stretches (typing, tool output, diffs) play at 1x; stretches where only the spinner updates
// play --fast times faster; any single gap is capped at --cap seconds. Nothing is added or reordered.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// xterm.js is resolved next to this file: `npm i @xterm/xterm@5.5.0` in this folder (or a copy of it) first.
const here = dirname(fileURLToPath(import.meta.url));
const [castPath, outPath, ...rest] = process.argv.slice(2);
const opt = (name, d) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : d; };
const fps = Number(opt("fps", 30)), fast = Number(opt("fast", 8)), cap = Number(opt("cap", 1));
const from = Number(opt("from", 0)), to = Number(opt("to", Infinity));
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;

const [headerLine, ...lines] = readFileSync(castPath, "utf8").trim().split("\n");
const header = JSON.parse(headerLine);
const events = lines.map((l) => JSON.parse(l)).filter((e) => e[1] === "o");

// Busy = a lot of bytes in a short window. Spinner/status-line ticks are small.
let prev = 0, out = 0;
const timeline = events.map(([t, , data], i) => {
  const dt = Math.max(0, t - prev); prev = t;
  const busy = data.length > 400 || (events[i + 1] && events[i + 1][0] - t < 0.03 && data.length > 40);
  if (t >= from && t <= to) out += Math.min(cap, busy ? dt : dt / fast);
  return { t, tOut: out, data, inRange: t <= to };
});
const pre = timeline.filter((e) => e.t < from);          // replayed instantly to build the starting screen
const play = timeline.filter((e) => e.t >= from && e.inRange);
const t0 = play.length ? play[0].tOut : 0;
const duration = play.length ? play[play.length - 1].tOut - t0 + 1.5 : 0;

const W = 1920, H = 1080;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const css = readFileSync(join(here, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
const js = readFileSync(join(here, "node_modules/@xterm/xterm/lib/xterm.js"), "utf8");
await page.setContent(`<!doctype html><html><head><style>${css}
  html,body{margin:0;background:#141414;height:100%;overflow:hidden}
  #wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
  #term{padding:0}
  .xterm-viewport{overflow:hidden!important}
</style></head><body><div id="wrap"><div id="term"></div></div><script>${js}</script></body></html>`);
await page.evaluate(async ({ cols, rows }) => {
  await document.fonts.load('26px "JetBrains Mono"');
  const term = new window.Terminal({
    cols, rows, fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", monospace', fontSize: 26, lineHeight: 1.05,
    allowProposedApi: true, scrollback: 0, cursorBlink: false, convertEol: false,
    theme: { background: "#141414", foreground: "#e6e6e6", cursor: "#141414" },
  });
  term.open(document.getElementById("term"));
  window.term = term;
  window.feed = (s) => new Promise((r) => term.write(s, r));
}, { cols: header.width, rows: header.height });

const feed = (s) => page.evaluate((s) => window.feed(s), s);
const preData = pre.map((e) => e.data).join("");
if (preData) await feed(preData);

if (stillAt != null) {
  const upTo = timeline.filter((e) => e.t <= Number(stillAt) && e.t >= from).map((e) => e.data).join("");
  await feed(upTo);
  await page.screenshot({ path: stillOut });
  await browser.close();
  console.log(`still at ${stillAt}s -> ${stillOut}`);
  process.exit(0);
}

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(duration * fps);
let k = 0, last = null;
for (let f = 0; f < frames; f++) {
  const now = t0 + f / fps;
  let chunk = "";
  while (k < play.length && play[k].tOut <= now) chunk += play[k++].data;
  if (chunk || !last) {
    if (chunk) await feed(chunk);
    last = await page.screenshot({ type: "jpeg", quality: 92 });
  }
  if (!ff.stdin.write(last)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (fps * 10) === 0) process.stderr.write(`\r${(f / fps).toFixed(0)}s / ${duration.toFixed(0)}s`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`\nwrote ${outPath}: ${duration.toFixed(1)}s at ${fps} fps (source ${play.length ? (play[play.length - 1].t - play[0].t).toFixed(0) : 0}s)`);
