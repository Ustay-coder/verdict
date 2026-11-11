/**
 * Exports the package entry points without starting services.
 * Consumers choose their runtime adapters explicitly; importing types must not open network or database connections.
 */
export * from "./schema/sqlite.js";
export { DrizzleStore, type SqliteDb } from "./store.js";
export { DrizzleAuth, sha256Hex, type KeyAuth } from "./auth.js";
export { fromD1 } from "./d1.js";
// Node-only helpers (better-sqlite3, fs) live in "./sqlite.js" and are imported lazily by callers:
//   const { fromSqliteFile } = await import("@verdict-ai/db/sqlite");

export { StoreError } from "./errors.js";
