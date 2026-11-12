/**
 * What each kind of tool does to the world, in the terms an MCP host reads before it calls one: whether it only
 * reads, whether a second call does the same thing again, and whether it reaches beyond this server. Kept in one
 * place so a tool's hints say what the tool does, and a test holds every tool to having them.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads what this server keeps. Nothing changes and no model is called. */
export const READS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Reads a hub over the network. Nothing here changes. */
export const READS_A_HUB: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Adds a record to what this server keeps; a second call adds another. */
export const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Asks models, may fetch pages or files, and stores what comes back. */
export const JUDGES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Reads a hub over the network and stores a copy here; a second call stores a second copy. */
export const COPIES_FROM_A_HUB: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Recomputes from stored scores; the same call gives the same total, and it writes only when asked to. */
export const RECOMPUTES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
