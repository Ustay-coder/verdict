/**
 * The version this package was published as and the oldest Node it runs on, read from its own package.json when
 * the CLI starts, so neither can fall behind a release. Node-only, like the rest of the CLI.
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string; engines: { node: string } };

export const VERSION: string = pkg.version;

/** The oldest Node this package says it runs on: package.json `engines.node`, which is written ">=A.B". */
export const MINIMUM_NODE: string = pkg.engines.node.replace(/^>=\s*/, "");

/**
 * What to tell someone whose Node is older than the package supports, or undefined when it is new enough.
 * Asked before anything else is loaded: on an old Node the failure would otherwise come later and from a dependency.
 */
export function nodeTooOld(current: string, minimum: string = MINIMUM_NODE): string | undefined {
  const parts = (version: string) => version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(current), need = parts(minimum);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > (need[i] ?? 0)) return undefined;
    if ((have[i] ?? 0) < (need[i] ?? 0)) return `Verdict needs Node ${minimum} or newer, and this is Node ${current}. Install a newer Node (https://nodejs.org) and run the command again.`;
  }
  return undefined;
}
