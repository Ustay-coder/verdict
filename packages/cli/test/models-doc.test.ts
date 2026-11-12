/**
 * The tables people choose a model from are written by hand in three places. They are held to the code: every name
 * `--models` takes, every decision provider, and every kind of input must be on the reference page, and the short
 * tables must not say a provider was checked live when the record of contracts does not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionProvider, Input } from "@verdict-ai/core";

import { parseModels } from "../src/models.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
const page = read("website/reference/models.md"), home = read("website/index.md"), readme = read("README.md"), record = read("docs/PROVIDERS.md");
/** The first column of the table of models: the rows under the heading that starts "Name it". */
function names(text: string): string[] {
  const lines = text.split("\n"), from = lines.findIndex((line) => line.startsWith("| Name it |"));
  const rows = lines.slice(from + 2, lines.findIndex((line, i) => i > from && !line.startsWith("|")));
  return rows.map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1] ?? "");
}

describe("the tables of models and inputs", () => {
  it("name every model the command line takes, and every decision provider", () => {
    const listed = names(page);
    for (const alias of ["jev", "jev-preview", "clef", "clef-flash", "gemini", "mock"]) {
      expect(listed, alias).toContain(alias);
      // The alias is one the command line really resolves.
      expect(parseModels(alias)[0]!.label).toBe(alias);
    }
    for (const provider of DecisionProvider.options) expect(listed.some((name) => name === provider || name.startsWith(`${provider}:`) || parseModels(name.replace("<model>", "x"))[0]!.provider === provider), provider).toBe(true);
    // The short tables carry the same names for what they list.
    for (const text of [home, readme]) for (const name of names(text)) expect(listed, name).toContain(name);
  });

  it("say a provider was checked against the live service only where the record of contracts does", () => {
    const live = (provider: string) => new RegExp(`^\\| \`${provider}\`[^\\n]*\\*\\*Live\\*\\*`, "m").test(record);
    expect([live("typesafe"), live("cloudflare"), live("openrouter"), live("openai"), live("gemini")]).toEqual([true, true, true, true, true]);
    for (const text of [page, home, readme]) {
      const row = (name: string) => text.split("\n").find((line) => line.startsWith(`| \`${name}\` |`)) ?? "";
      for (const name of ["jev", "clef", "clef-flash", "openrouter:<model>", "openai:<model>", "gemini"]) expect(row(name), name).toMatch(/\| Yes/);
      // An endpoint of your own is never claimed as checked.
      expect(row("systemone:<model>")).toMatch(/\| You check it/);
    }
  });

  it("list every kind of input the engine takes", () => {
    const kinds = Input.options.map((option) => option.shape.type.value);
    expect(kinds.sort()).toEqual(["file", "image", "json", "text", "url", "youtube"]);
    for (const kind of kinds) expect(page, kind).toContain(`"type": "${kind}"`);
    for (const text of [home, readme]) for (const word of ["Text", "File", "JSON", "Web page", "YouTube", "Image"]) expect(text, word).toContain(`| ${word} |`);
  });
});
