/**
 * Reads command files at the Node boundary with actionable path diagnostics.
 * OS failures retain their category; JSON and rubric syntax errors belong to their parsers.
 */
import { FileAccessError } from "@verdict-ai/core";
import { readFile } from "node:fs/promises";

/** Reads UTF-8 text or rejects with FileAccessError distinguishing missing paths and permissions. */
export async function readText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (cause) { throw new FileAccessError(path, "read", cause); }
}
