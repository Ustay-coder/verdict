// Run: pnpm --filter @verdict-ai/cli exec verdict serve -p 8787   (with VERDICT_API_KEYS="sk_demo:acme")
// Then: cd examples && pnpm sdk
import { Verdict } from "@verdict-ai/sdk";
import { readFileSync } from "node:fs";
const v = new Verdict({ baseUrl: "http://localhost:8787", apiKey: "sk_demo" });
const rubric = await v.rubrics.create(readFileSync("rubrics/offline-benchmark.yaml", "utf8"));
console.log("rubric", rubric.id, rubric.criteria.length);
const ev = await v.evaluations.create({ rubric: rubric.id, name: "release 2.0", inputs: [
  { type: "json", data: JSON.parse(readFileSync("inputs/ci.json", "utf8")), label: "ci", tags: ["ci"] },
  { type: "file", base64: readFileSync("inputs/CHANGELOG.md").toString("base64"), filename: "CHANGELOG.md" },
  { type: "file", base64: readFileSync("inputs/pitch.pdf").toString("base64"), filename: "pitch.pdf" },
]});
console.log("eval", ev.id, ev.status, ev.aggregate.score, ev.aggregate.grade, ev.aggregate.passed);
console.log("criteria", ev.criteria.map(c => `${c.criterionId}=${c.score}`).join(" "));
const re = await v.evaluations.reaggregate(ev.id, { method: "min" });
console.log("min", re.aggregate.score);
const queued = await v.evaluations.createAsync({ rubric: rubric.id, inputs: [{ type: "text", text: "breaking changes" }] });
const done = await v.evaluations.wait(queued.id, { intervalMs: 50 });
console.log("async", queued.status, "->", done.status, done.aggregate.score);
try { await new Verdict({ baseUrl: "http://localhost:8787", apiKey: "bad" }).rubrics.list(); } catch (e) { console.log("auth error ok:", e.status, e.message); }
const unauth = await fetch("http://localhost:8787/v1/openapi.json"); console.log("openapi", unauth.status, Object.keys((await unauth.json()).paths).length, "paths");
