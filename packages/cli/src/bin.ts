#!/usr/bin/env node
/**
 * Starts the executable transport at the process boundary.
 * Library imports remain side-effect free; startup failures must be visible to the invoking process.
 */
import { nodeTooOld } from "./package-version.js";

// why: checked before the command tree is loaded, so an old Node gets one plain sentence instead of a dependency's stack trace.
const old = nodeTooOld(process.versions.node);
if (old) { console.error(old); process.exit(1); }
const [{ fail }, { buildCli }] = await Promise.all([import("./fail.js"), import("./index.js")]);
buildCli().parseAsync(process.argv).catch((e: unknown) => { fail(e instanceof Error ? e.message : String(e)); });
