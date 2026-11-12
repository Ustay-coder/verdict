#!/usr/bin/env node
/**
 * Starts the executable transport at the process boundary.
 * Library imports remain side-effect free; startup failures must be visible to the invoking process.
 */
import { nodeTooOld } from "./package-version.js";

// why: checked before the server is loaded; the message goes to stderr, which a host shows when a server fails to start.
const old = nodeTooOld(process.versions.node);
if (old) { console.error(old); process.exit(1); }
const [{ StdioServerTransport }, { createMcpServer }] = await Promise.all([import("@modelcontextprotocol/sdk/server/stdio.js"), import("./index.js")]);
const server = createMcpServer();
await server.connect(new StdioServerTransport());
