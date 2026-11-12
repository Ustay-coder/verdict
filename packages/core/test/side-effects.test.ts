import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getDecisionProvider } from "../src/index.js";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? sources(join(dir, e.name)) : Promise.resolve(e.name.endsWith(".ts") ? [join(dir, e.name)] : []))));
  return nested.flat();
}

describe("bundling", () => {
  // Packages declare "sideEffects": false, so bundlers (esbuild in wrangler) drop imports kept only for their side
  // effects. One such import once left Workers without any decision provider.
  it("has no side-effect-only imports in packages marked side-effect free", async () => {
    const offenders: string[] = [];
    for (const name of await readdir(packages)) {
      const manifest = JSON.parse(await readFile(join(packages, name, "package.json"), "utf8").catch(() => "{}")) as { sideEffects?: unknown };
      if (manifest.sideEffects !== false) continue;
      for (const file of await sources(join(packages, name, "src"))) {
        const text = await readFile(file, "utf8");
        for (const m of text.matchAll(/^import\s+["'][^"']+["'];?$/gm)) offenders.push(`${file.slice(packages.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registers the built-in decision providers when the engine is imported", () => {
    for (const name of ["typesafe", "cloudflare", "systemone", "openrouter", "openai", "gemini", "mock"]) expect(getDecisionProvider(name).name).toBe(name);
  });
});
