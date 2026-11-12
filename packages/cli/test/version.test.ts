import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildCli } from "../src/index.js";
import { MINIMUM_NODE, nodeTooOld } from "../src/package-version.js";

const published = (pkg: string) => (JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

it("prints the version it was published as, not a number written into the source", () => {
  expect(buildCli().version()).toBe(published("cli"));
});

it("is released together with the packages it is built on", () => {
  for (const pkg of ["core", "db", "sdk", "api", "mcp"]) expect(published(pkg), pkg).toBe(published("cli"));
});

// What the packages say about Node is held together here, because it had drifted: the packages said 20, a dependency
// needed 24, and reading a PDF failed on 20 with "Iterator is not defined".
const engines = (pkg: string) => (JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), "utf8")) as { engines: { node: string } }).engines.node;
const minimum = (range: string) => { const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim()); if (!m) throw new Error(`a Node range this test cannot read: ${range}`); return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] as const; };
const atLeast = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! > b[i]!; } return true; };
/** The package.json of a dependency as it is installed for the package that depends on it (read as a file: a package may not export it). */
function installed(dependency: string, from: string): { engines?: { node?: string } } {
  return JSON.parse(readFileSync(new URL(`../../${from}/node_modules/${dependency}/package.json`, import.meta.url), "utf8")) as { engines?: { node?: string } };
}

it("says one thing about the oldest Node it runs on, in the packages and in what people read", () => {
  for (const pkg of ["core", "db", "sdk", "api", "mcp"]) expect(engines(pkg), pkg).toBe(">=22");
  // The CLI's argument parser needs a later 22 than the rest.
  expect(engines("cli")).toBe(">=22.12");
  expect(MINIMUM_NODE).toBe("22.12");
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  expect(read("README.md")).toContain("Node 22 or newer.");
  expect(read("website/guide/getting-started.md")).toContain("Use Node 22 or newer.");
  for (const pkg of ["core", "db", "sdk", "api", "mcp", "cli"]) expect(read(`packages/${pkg}/README.md`), pkg).toContain("Requires Node 22 or newer.");
});

it("does not depend on a library that needs a newer Node than it promises", () => {
  // The two that had moved ahead: the PDF reader (core) and the argument parser (cli).
  for (const [dependency, from] of [["unpdf", "core"], ["commander", "cli"]] as const) {
    const needs = installed(dependency, from).engines?.node;
    if (needs) expect(atLeast(minimum(engines(from)), minimum(needs)), `${dependency} needs Node ${needs}; ${from} promises ${engines(from)}`).toBe(true);
  }
});

it("tells someone on an older Node what is wrong in one sentence", () => {
  expect(nodeTooOld("20.20.2")).toBe("Verdict needs Node 22.12 or newer, and this is Node 20.20.2. Install a newer Node (https://nodejs.org) and run the command again.");
  expect(nodeTooOld("22.11.0")).toContain("this is Node 22.11.0");
  for (const fine of ["22.12.0", "22.23.4", "24.0.0", "26.1.0"]) expect(nodeTooOld(fine), fine).toBeUndefined();
  // The running Node passes, or this test could not be running the CLI at all.
  expect(nodeTooOld(process.versions.node)).toBeUndefined();
});
