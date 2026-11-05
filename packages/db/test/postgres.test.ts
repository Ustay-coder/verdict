import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { fromPglite, applyPgMigrations } from "../src/postgres.js";

it("applies Postgres migrations idempotently and stores documents as jsonb", async () => {
  const h = await fromPglite();
  try {
    const before = await h.db.execute(sql`select * from __migrations order by name`);
    await applyPgMigrations(h.db);
    expect((await h.db.execute(sql`select * from __migrations order by name`)).rows).toEqual(before.rows);
    const columns = await h.db.execute(sql`select data_type from information_schema.columns where table_schema = 'public' and table_name in ('rubrics', 'evaluations') and column_name = 'doc'`);
    expect(columns.rows).toEqual([{ data_type: "jsonb" }, { data_type: "jsonb" }]);
  } finally { await h.close(); }
}, 30000);
