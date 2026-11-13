/**
 * The Worker as it is deployed: bundled into one file by esbuild, the bundler `wrangler deploy` runs, and served by
 * Cloudflare's own runtime (workerd, through Miniflare). The other suites load modules one by one, where every module
 * runs. A bundler honours `"sideEffects": false` instead, and leaves out a module that is imported for its effect
 * alone — registering the built-in decision providers was once such an import. It needs no network and no account.
 * What it cannot show: what `wrangler` adds around esbuild (its Node polyfills, the bindings of `wrangler.toml`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { build, type BuildOptions, type Message } from "esbuild";
import { Miniflare } from "miniflare";

const root = join(__dirname, "../../..");
let warnings: Message[] = [];
let mf: Miniflare | undefined;

/** A Worker that uses the provider registry and nothing else of the engine: no judge, so nothing that might fill it. */
const LOOKUP = `import { getDecisionProvider } from "@verdict-ai/core";
export default { fetch() { return new Response(getDecisionProvider("mock").name); } };`;

/** One file, under the options wrangler passes to esbuild for a module Worker with `nodejs_compat`. */
async function bundle(entry: Pick<BuildOptions, "entryPoints" | "stdin">) {
  const result = await build({ ...entry, absWorkingDir: root, bundle: true, write: false, format: "esm", target: "es2024", platform: "browser", conditions: ["workerd", "worker", "browser"], external: ["node:*"], logLevel: "silent" });
  return { warnings: result.warnings, code: result.outputFiles[0]!.text };
}

beforeAll(async () => {
  const api = await bundle({ entryPoints: [join(root, "packages/api/src/worker.ts")] });
  const lookup = await bundle({ stdin: { contents: LOOKUP, resolveDir: join(root, "packages/api"), sourcefile: "lookup.js" } });
  warnings = [...api.warnings, ...lookup.warnings];
  // The date is one the pinned runtime knows; `wrangler.toml` may name a later one.
  const runtime = { compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"] };
  mf = new Miniflare({ workers: [
    { name: "api", modules: [{ type: "ESModule", path: "worker.js", contents: api.code }], ...runtime },
    { name: "lookup", modules: [{ type: "ESModule", path: "lookup.js", contents: lookup.code }], ...runtime },
  ] });
  await mf.ready;
}, 60_000);

afterAll(async () => { await mf?.dispose(); });

describe("the bundled Worker", () => {
  it("keeps every import its own packages make for an effect", () => {
    const dropped = warnings.filter((w) => w.id === "ignored-bare-import" && !w.location?.file.includes("node_modules"));
    expect(dropped.map((w) => `${w.location?.file}:${w.location?.line} ${w.location?.lineText}`)).toEqual([]);
  });

  it("scores a rubric with a built-in decision provider", async () => {
    const rubric = { name: "Mock", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "a", name: "A" }] };
    const res = await mf!.dispatchFetch("http://verdict.test/v1/evaluations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rubric, inputs: [{ type: "text", text: "hello" }] }) });
    const evaluation = await res.json() as { status: string; criteria: Array<{ status: string; ratings: Array<{ status: string; error?: string }> }> };
    expect(evaluation.criteria[0]?.ratings.map((r) => r.error)).toEqual([undefined]);
    expect(res.status).toBe(201);
    expect(evaluation).toMatchObject({ status: "completed", criteria: [{ status: "scored" }] });
  });

  it("hands the built-in providers to a bundle that only looks one up", async () => {
    const worker = await mf!.getWorker("lookup");
    const res = await worker.fetch("http://verdict.test/");
    expect(await res.text()).toBe("mock");
  });
});
