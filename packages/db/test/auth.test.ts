import { describe, expect, it } from "vitest";
import { ValidationError } from "@verdict-ai/core";
import { backends } from "./backends.js";

describe.each(backends)("DrizzleAuth on $name", ({ open }) => {
  it("creates hashed keys, resolves tenants, revokes, and falls back to env keys", async () => {
    const { auth, db, tables: { apiKeys } } = await open( { resolve: (k) => (k === "sk_env" ? "env_tenant" : undefined) });
    await expect(auth.createKey("", "ci")).rejects.toBeInstanceOf(ValidationError);
    const { key, id, prefix } = await auth.createKey("acme", "ci");
    expect(key.startsWith("vk_live_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 12));
    // A stored key says who it is, so history can name it; a fallback key resolves to what the fallback says.
    expect(await auth.resolve(key)).toEqual({ tenantId: "acme", actor: { kind: "key", id, name: "ci" } });
    expect(await auth.resolve("vk_live_nope")).toBeUndefined();
    expect(await auth.resolve("sk_env")).toBe("env_tenant");
    expect(await auth.resolve(undefined)).toBeUndefined();

    const rows = await db.select().from(apiKeys);
    expect(rows[0]!.keyHash).not.toContain(key.slice(8)); // never stored in plaintext
    expect(rows[0]!.keyHash).toHaveLength(64);

    expect(await auth.revokeKey(id, "other")).toBe(false);
    expect(await auth.revokeKey(id, "acme")).toBe(true);
    expect(await auth.resolve(key)).toBeUndefined();
    expect((await auth.listKeys("acme"))[0]!.revokedAt).toBeTruthy();
  }, 30000);
});
