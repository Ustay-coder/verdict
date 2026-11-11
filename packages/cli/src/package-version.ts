/**
 * The version this package was published as, read from its own package.json when the CLI starts, so `--version`
 * cannot fall behind a release. Node-only, like the rest of the CLI.
 */
import { createRequire } from "node:module";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
