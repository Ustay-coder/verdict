#!/usr/bin/env node
/**
 * Starts the executable transport at the process boundary.
 * Library imports remain side-effect free; startup failures must be visible to the invoking process.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index.js";

const server = createMcpServer();
await server.connect(new StdioServerTransport());
