import { getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { schema as sqliteSchema } from "./schema/sqlite.js";
import type { schema as pgSchema } from "./schema/pg.js";
import type { SqliteDb } from "./store.js";
import type { PgDb } from "./dialects.js";

type Tables = typeof sqliteSchema | typeof pgSchema;
type TableName = keyof Tables;
type Row<Name extends TableName> = (typeof sqliteSchema)[Name]["$inferSelect"];
type Insert<Name extends TableName> = (typeof sqliteSchema)[Name]["$inferInsert"];
type SelectOptions = { where?: SQL; orderBy?: SQL; limit?: number };

/** SQL composition is shared; each driver retains its own tables and column codecs. */
export class DocumentQueries {
  constructor(readonly tables: Tables, private read: (query: SQL) => Promise<unknown[]>, private execute: (query: SQL) => Promise<unknown>) { }

  async select<Name extends TableName>(name: Name, options: SelectOptions = {}): Promise<Row<Name>[]> {
    const table = this.tables[name];
    const columns: Record<string, AnyColumn> = getTableColumns(table);
    const projection = Object.entries(columns).map(([key, column]) => sql`${column} as ${sql.identifier(key)}`);
    const query = sql`select ${sql.join(projection, sql`, `)} from ${table}`;
    if (options.where) query.append(sql` where ${options.where}`);
    if (options.orderBy) query.append(sql` order by ${options.orderBy}`);
    if (options.limit !== undefined) query.append(sql` limit ${options.limit}`);
    return (await this.read(query)).map(value => decodeRow<Name>(value, columns));
  }

  /** A read the table projection cannot express (counts, groups). Rows come back as the driver returns them. */
  async rows(query: SQL): Promise<Array<Record<string, unknown>>> {
    return (await this.read(query)) as Array<Record<string, unknown>>;
  }

  async insert<Name extends TableName>(name: Name, rows: Insert<Name>[], conflict?: { keys: Array<keyof Insert<Name>>; set: Partial<Insert<Name>> }): Promise<void> {
    if (!rows.length) return;
    const table = this.tables[name];
    const columns: Record<string, AnyColumn> = getTableColumns(table);
    // why: omit undefined values so schema defaults still apply; all rows in a projection share the same shape.
    const keys = Object.keys(rows[0]!).filter(key => rows[0]![key as keyof Insert<Name>] !== undefined);
    const values = rows.map(row => sql`(${sql.join(keys.map(key => sql`${sql.param(row[key as keyof Insert<Name>], columns[key])}`), sql`, `)})`);
    const query = sql`insert into ${table} (${sql.join(keys.map(key => sql.identifier(columns[key]!.name)), sql`, `)}) values ${sql.join(values, sql`, `)}`;
    if (conflict) {
      const targets = conflict.keys.map(key => sql.identifier(columns[String(key)]!.name));
      query.append(sql` on conflict (${sql.join(targets, sql`, `)}) do update set ${assignments(conflict.set, columns)}`);
    }
    await this.execute(query);
  }

  async update<Name extends TableName>(name: Name, set: Partial<Insert<Name>>, where: SQL): Promise<void> {
    await this.execute(sql`update ${this.tables[name]} set ${assignments(set, getTableColumns(this.tables[name]))} where ${where}`);
  }

  async delete(name: TableName, where: SQL): Promise<void> {
    await this.execute(sql`delete from ${this.tables[name]} where ${where}`);
  }
}

function assignments(values: object, columns: Record<string, AnyColumn>): SQL {
  return sql.join(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => sql`${sql.identifier(columns[key]!.name)} = ${sql.param(value, columns[key])}`), sql`, `);
}

function decodeRow<Name extends TableName>(value: unknown, columns: Record<string, AnyColumn>): Row<Name> {
  if (!value || typeof value !== "object") throw new TypeError("driver returned a non-object row");
  const row = value as Record<string, unknown>;
  // why: raw SQL bypasses Drizzle's select mapper; reuse the actual dialect's JSON/boolean codecs.
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, row[key] === null ? null : column.mapFromDriverValue(row[key])])) as Row<Name>;
}

export function sqliteQueries(db: SqliteDb, tables: typeof sqliteSchema): DocumentQueries {
  return new DocumentQueries(tables, async query => await db.all(query), async query => await db.run(query));
}

export function postgresQueries(db: PgDb, tables: typeof pgSchema): DocumentQueries {
  return new DocumentQueries(tables, async query => {
    const result = await db.execute(query);
    if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) throw new TypeError("Postgres driver returned no rows");
    return result.rows;
  }, async query => await db.execute(query));
}
