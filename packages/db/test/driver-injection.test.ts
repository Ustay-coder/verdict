import type BetterSqlite3 from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { fromPostgres, fromPglite } from "../src/postgres.js";
import { fromSqliteFile } from "../src/sqlite.js";

it("loads each Node driver through its injected loader without importing native drivers", async () => {
  const load = vi.fn(async () => { throw new Error("driver unavailable"); });
  await expect(fromSqliteFile(":memory:", undefined, load)).rejects.toThrow("driver unavailable");
  await expect(fromPostgres("unused", undefined, load)).rejects.toThrow("driver unavailable");
  await expect(fromPglite(undefined, undefined, load)).rejects.toThrow("driver unavailable");
  expect(load).toHaveBeenCalledTimes(3);
});

it("releases an injected SQLite handle when initialization fails before migrations", async () => {
  const close = vi.fn();
  const pragma = vi.fn(() => { throw new Error("read only"); });
  const Database = vi.fn<typeof BetterSqlite3>().mockReturnValue({ pragma, close } as BetterSqlite3.Database);
  // Only the exercised driver surface is supplied; no native module is loaded.
  await expect(fromSqliteFile("virtual.sqlite", undefined, async () => ({ default: Database }))).rejects.toThrow("initialize SQLite virtual.sqlite");
  expect(Database).toHaveBeenCalledWith("virtual.sqlite");
  expect(close).toHaveBeenCalledOnce();
});
