import { describe, expect, it } from "vitest";
import { fromSqliteFile } from "../src/sqlite.js";

describe("DrizzleAuth", () => {
  it("creates hashed keys, resolves tenants, revokes, and falls back to env keys", async () => {
    const { auth, db } = await fromSqliteFile(":memory:", { resolve: (k) => (k === "sk_env" ? "env_tenant" : undefined) });
    const { key, id, prefix } = await auth.createKey("acme", "ci");
    expect(key.startsWith("vk_live_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 12));
    expect(await auth.resolve(key)).toBe("acme");
    expect(await auth.resolve("vk_live_nope")).toBeUndefined();
    expect(await auth.resolve("sk_env")).toBe("env_tenant");
    expect(await auth.resolve(undefined)).toBeUndefined();

    const { apiKeys } = await import("../src/schema/sqlite.js");
    const rows = await db.select().from(apiKeys);
    expect(rows[0]!.keyHash).not.toContain(key.slice(8)); // never stored in plaintext
    expect(rows[0]!.keyHash).toHaveLength(64);

    expect(await auth.revokeKey(id, "other")).toBe(false);
    expect(await auth.revokeKey(id, "acme")).toBe(true);
    expect(await auth.resolve(key)).toBeUndefined();
    expect((await auth.listKeys("acme"))[0]!.revokedAt).toBeTruthy();
  });
});
