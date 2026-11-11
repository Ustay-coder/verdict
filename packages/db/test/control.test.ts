import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_MAX_CHANGES, freezeRubric, type PromotionEvent } from "@verdict-ai/core";
import { controlStoreContract } from "../../core/test/control-contract.js";
import { fromSqliteFile } from "../src/sqlite.js";
import { DrizzleStore } from "../src/store.js";
import { backends } from "./backends.js";

describe.each(backends)("control store on $name", ({ open }) => {
  controlStoreContract(async () => (await open()).store.control);
});

// D1 has no interactive transaction: statements go out as one batch of prepared statements, each with at most 100
// bound parameters. This runs the same conversion as `fromD1` against a local SQLite file and counts them.
const D1_MAX_PARAMETERS = 100;

async function d1Like() {
  const { db, sqlite } = await fromSqliteFile(":memory:");
  const dialect = new SQLiteAsyncDialect();
  const parameters: number[] = [];
  const batch = async (statements: SQL[]) => {
    const queries = statements.map((statement) => dialect.sqlToQuery(statement));
    parameters.push(...queries.map((q) => q.params.length));
    sqlite.transaction(() => { for (const q of queries) sqlite.prepare(q.sql).run(...q.params); })();
  };
  return { store: new DrizzleStore(db, batch), parameters, close: () => sqlite.close() };
}

describe("control store through a D1-style batch", () => {
  const opened: Array<() => void> = [];
  afterEach(() => { for (const close of opened.splice(0)) close(); });
  controlStoreContract(async () => {
    const h = await d1Like();
    opened.push(h.close);
    return h.store.control;
  });

  it("keeps the largest promotion a request may carry within D1's parameter limit", async () => {
    const { store, parameters, close } = await d1Like();
    try {
      const scope = { tenantId: "t1", project: "p" };
      await store.control.createProject({ tenantId: "t1", name: "p", createdAt: "2026-11-10T00:00:00.000Z" });
      await store.control.createEnvironment({ ...scope, name: "prod", createdAt: "2026-11-10T00:00:00.000Z" });
      const frozen = await freezeRubric({ name: "r", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "q", name: "Q?", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }] });
      const names = Array.from({ length: CONTROL_MAX_CHANGES }, (_, i) => `rubric-${i}`);
      for (const name of names) await store.control.putVersion({ ...frozen, ...scope, name });
      const event = (name: string, i: number, from: string | null, at: string): PromotionEvent => ({ ...scope, id: `prm_${at}_${i}`, environment: "prod", name, from, to: frozen.id, kind: "promote", at });
      // All but one pointer exist already, so the guard carries its largest mix: moved, fresh and target conditions.
      expect(await store.control.applyPromotions(names.slice(1).map((name, i) => event(name, i, null, "2026-11-10T00:00:01.000Z")))).toEqual({ ok: true });
      parameters.length = 0;
      const mixed = names.map((name, i) => event(name, i, i === 0 ? null : frozen.id, "2026-11-10T00:00:02.000Z"));
      expect(await store.control.applyPromotions(mixed)).toEqual({ ok: true });
      expect(Math.max(...parameters)).toBeLessThanOrEqual(D1_MAX_PARAMETERS);
      expect(await store.control.listPointers(scope, "prod")).toHaveLength(CONTROL_MAX_CHANGES);
      await expect(store.control.applyPromotions([...mixed, event("one-more", 99, null, "2026-11-10T00:00:03.000Z")])).rejects.toThrow("at most 20");
    } finally { close(); }
  }, 30000);
});
