#!/usr/bin/env node
/**
 * Starts the executable transport at the process boundary.
 * Library imports remain side-effect free; startup failures must be visible to the invoking process.
 */
import { fail } from "./fail.js";
import { buildCli } from "./index.js";
buildCli().parseAsync(process.argv).catch((e) => { fail(e instanceof Error ? e.message : String(e)); });
