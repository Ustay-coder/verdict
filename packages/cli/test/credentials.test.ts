import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, fileCredentials, hubTarget } from "../src/hub/credentials.js";

describe("hub credentials", () => {
  it("live under XDG_CONFIG_HOME, readable only by the user", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-cred-"));
    try {
      const path = credentialsPath({ XDG_CONFIG_HOME: dir });
      expect(path).toBe(join(dir, "verdict", "hub.json"));
      const store = fileCredentials(path);
      expect(await store.read()).toBeUndefined();
      await store.write({ hub: "https://hub.example", apiKey: "vk_1", keyId: "key_1", handle: "alice" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await store.read()).toEqual({ hub: "https://hub.example", apiKey: "vk_1", keyId: "key_1", handle: "alice" });
      await store.remove();
      expect(await store.read()).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keep one sign-in per server, the most recent first, and still read a file written for one server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-cred-"));
    try {
      const path = join(dir, "hub.json");
      // The file as it was before servers were kept apart.
      await writeFile(path, JSON.stringify({ hub: "https://hub.example", apiKey: "vk_old", keyId: "key_old", handle: "alice" }));
      const store = fileCredentials(path);
      expect(await store.read()).toEqual({ hub: "https://hub.example", apiKey: "vk_old", keyId: "key_old", handle: "alice" });
      await store.write({ hub: "https://team.example", apiKey: "vk_team" });
      expect(await store.read()).toEqual({ hub: "https://team.example", apiKey: "vk_team" });
      expect(await store.read("https://hub.example/")).toMatchObject({ apiKey: "vk_old" });
      expect(await store.read("https://nowhere.example")).toBeUndefined();
      // An older CLI reads the top level: the most recent sign-in.
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ hub: "https://team.example", apiKey: "vk_team", servers: { "https://hub.example": { apiKey: "vk_old" }, "https://team.example": { apiKey: "vk_team" } } });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await hubTarget(store, {}, "https://hub.example")).toMatchObject({ hub: "https://hub.example", apiKey: "vk_old" });
      expect(await hubTarget(store, {}, undefined, "https://hub.example")).toMatchObject({ apiKey: "vk_old" });
      expect(await hubTarget(store, { VERDICT_HUB_URL: "https://team.example" }, undefined, "https://hub.example")).toMatchObject({ apiKey: "vk_team" });
      await store.remove();
      expect(await store.read()).toMatchObject({ hub: "https://hub.example" });
      await store.remove("https://hub.example");
      expect(await store.read()).toBeUndefined();
      await expect(stat(path)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("pick the hub from the flag, then the environment, then the saved sign-in, and use a saved key only for its own hub", async () => {
    const saved = { hub: "https://saved.example/", apiKey: "vk_saved" };
    const store = { read: async () => saved, write: async () => {}, remove: async () => {} };
    expect(await hubTarget(store, {})).toMatchObject({ hub: "https://saved.example", apiKey: "vk_saved" });
    expect(await hubTarget(store, { VERDICT_HUB_URL: "https://env.example" })).toEqual({ hub: "https://env.example", apiKey: undefined, saved: undefined });
    expect(await hubTarget(store, { VERDICT_HUB_URL: "https://env.example", VERDICT_HUB_KEY: "vk_ci" }, "https://flag.example")).toMatchObject({ hub: "https://flag.example", apiKey: "vk_ci" });
    const empty = { read: async () => undefined, write: async () => {}, remove: async () => {} };
    await expect(hubTarget(empty, {})).rejects.toThrow(/no hub configured/);
  });
});
