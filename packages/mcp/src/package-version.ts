/**
 * The version this package was published as, read from its own package.json when the server starts, so the
 * version it reports to a client cannot fall behind a release. Node-only, like the rest of this package.
 */
import { createRequire } from "node:module";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
