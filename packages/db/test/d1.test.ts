/**
 * The store on a local D1: Cloudflare's own runtime (workerd, through Miniflare) serving the D1 API — prepared
 * statements, `bind`, `batch` — over the real migrations. The other suites reach SQLite through another driver; this
 * one goes through `fromD1`, the path a deployed Worker takes. It needs no network and no account.
 * What it cannot show: limits only the hosted service enforces. Those are checked by counting (control.test.ts).
 */
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { CONTROL_MAX_CHANGES, Engine, freezeRubric, type PromotionEvent } from "@verdict-ai/core";
import { controlStoreContract } from "../../core/test/control-contract.js";
import { fromD1 } from "../src/d1.js";

const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: ["DB"] });
let migrated: Promise<D1Database> | undefined;

/** The one database of this file, migrated once and emptied before each use. */
async function database(): Promise<D1Database> {
  migrated ??= (async () => {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    const dir = join(__dirname, "../drizzle");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const statements = readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const statement of statements) await db.prepare(statement).run();
    }
    return db;
  })();
  const db = await migrated;
  const tables = await db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'd1_%'").all<{ name: string }>();
  await db.batch(tables.results.map((t) => db.prepare(`delete from "${t.name}"`)));
  return db;
}

afterAll(async () => { await mf.dispose(); });

describe("control store on a local D1", () => {
  controlStoreContract(async () => fromD1(await database()).store.control);

  it("applies the largest promotion a request may carry as one batch", async () => {
    const { store } = fromD1(await database());
    const scope = { tenantId: "t1", project: "p" };
    await store.control.createProject({ tenantId: "t1", name: "p", createdAt: "2026-11-10T00:00:00.000Z" });
    await store.control.createEnvironment({ ...scope, name: "prod", createdAt: "2026-11-10T00:00:00.000Z" });
    const frozen = await freezeRubric({ name: "r", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "q", name: "Q?", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }] });
    const names = Array.from({ length: CONTROL_MAX_CHANGES }, (_, i) => `rubric-${i}`);
    for (const name of names) await store.control.putVersion({ ...frozen, ...scope, name });
    const event = (name: string, i: number, from: string | null, at: string): PromotionEvent => ({ ...scope, id: `prm_${at}_${i}`, environment: "prod", name, from, to: frozen.id, kind: "promote", at });
    expect(await store.control.applyPromotions(names.slice(1).map((name, i) => event(name, i, null, "2026-11-10T00:00:01.000Z")))).toEqual({ ok: true });
    expect(await store.control.applyPromotions(names.map((name, i) => event(name, i, i === 0 ? null : frozen.id, "2026-11-10T00:00:02.000Z")))).toEqual({ ok: true });
    expect(await store.control.listPointers(scope, "prod")).toHaveLength(CONTROL_MAX_CHANGES);
    // A stale batch leaves every pointer where it was.
    const stale = names.map((name, i) => event(name, i, i === 7 ? null : frozen.id, "2026-11-10T00:00:03.000Z"));
    expect(await store.control.applyPromotions(stale)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.control.listHistory(scope, { limit: 100 })).toHaveLength(CONTROL_MAX_CHANGES * 2 - 1);
  }, 60000);
});

describe("the rest of the store on a local D1", () => {
  it("stores rubrics and evaluations, resolves keys, and keeps tenants apart", async () => {
    const { store, auth } = fromD1(await database());
    const engine = new Engine({ store });
    const rubric = await engine.createRubric({ name: "x", criteria: [{ id: "a", name: "a", judge: { type: "benchmark", method: "keywords", keywords: ["a"] } }] }, "t1");
    const evaluation = await engine.evaluate({ rubric: rubric.id!, subject: { name: "s", inputs: [{ type: "text", text: "a b c" }] }, tenantId: "t1" });
    expect(evaluation.status).toBe("completed");
    expect((await store.listEvaluations({ tenantId: "t1" })).map((e) => e.id)).toEqual([evaluation.id]);
    expect(await store.listEvaluations({ tenantId: "t2" })).toEqual([]);
    expect(await store.getRubric(rubric.id!, "t2")).toBeUndefined();
    const { key, id } = await auth.createKey("t1", "ci");
    expect(await auth.resolve(key)).toEqual({ tenantId: "t1", actor: { kind: "key", id, name: "ci" } });
    expect(await auth.revokeKey(id, "t1")).toBe(true);
    expect(await auth.resolve(key)).toBeUndefined();
  }, 60000);
});
