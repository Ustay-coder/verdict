import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildCli } from "../src/index.js";

const published = (pkg: string) => (JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

it("prints the version it was published as, not a number written into the source", () => {
  expect(buildCli().version()).toBe(published("cli"));
});

it("is released together with the packages it is built on", () => {
  for (const pkg of ["core", "db", "sdk", "api", "mcp"]) expect(published(pkg), pkg).toBe(published("cli"));
});
