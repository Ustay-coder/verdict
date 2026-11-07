// mcp-score.mjs <script.md>...: evaluates each script the way the agent does, through the verdict MCP server
// (file inputs labelled by file name, subject "Small Desk Studio script"), and prints every criterion.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)), v2 = resolve(here, ".."), repo = resolve(v2, "../../../..");
const srv = spawn("node", [join(repo, "packages/cli/dist/bin.js"), "mcp"], {
  env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1", VERDICT_DATA_DIR: join(here, ".verdict") }, stdio: ["pipe", "pipe", "inherit"],
});
let buf = "", id = 0; const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const call = async (name, args) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cal", version: "1" } });
const rubric = await call("create_rubric", { rubric: readFileSync(join(v2, "sponsor-review-strict.yaml"), "utf8") });
await Promise.all(process.argv.slice(2).map(async (file) => {
  const dir = mkdtempSync(join(here, ".work-")); copyFileSync(file, join(dir, "script.md"));
  for (const f of ["brief.json", "notes.json"]) copyFileSync(join(v2, "start", f), join(dir, f));
  const r = await call("evaluate", { rubric: rubric.id, name: "Small Desk Studio script", inputs: [
    { type: "file", path: join(dir, "script.md"), tags: ["script"] }, { type: "file", path: join(dir, "brief.json"), tags: ["brief"] }, { type: "file", path: join(dir, "notes.json"), tags: ["notes"] }] });
  console.log(`== ${basename(file)}: ${r.score} ${r.grade} | ` + r.criteria.map((c) => `${c.id}=${Math.round((c.normalized ?? 0) * 100)}`).join(" "));
}));
srv.kill();
