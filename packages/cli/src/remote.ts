/**
 * Selects local or remote command execution and resolves rubric references.
 * Provider keys remain in the environment; mock overrides apply only after rubric validation.
 */
import { Engine, FileStore, lazyPlaywrightScreenshot, loadRubricText, type Rubric } from "@verdict-ai/core";
import { Verdict } from "@verdict-ai/sdk";
import { readText } from "./files.js";
import { resolve } from "node:path";
import { mockify } from "./mock.js";

/** Returns the configured local data directory; performs no filesystem access. */
export const dataDir = (env = process.env, cwd = process.cwd()) => env.VERDICT_DATA_DIR ?? resolve(cwd, ".verdict");

/** Creates a local engine with file persistence; filesystem failures surface when operations run. Playwright loads only if a URL asks for a screenshot. */
export function localEngine(directory = dataDir()) {
  return new Engine({ store: new FileStore(directory), ingest: { allowLocalFiles: true, screenshot: lazyPlaywrightScreenshot() } });
}
/** Returns a configured API client, or undefined when no remote URL is set. */
export function remote(env = process.env): Verdict | undefined {
  return env.VERDICT_API_URL ? new Verdict({ baseUrl: env.VERDICT_API_URL, apiKey: env.VERDICT_API_KEY }) : undefined;
}

/** Resolves a file or stored-rubric reference; rejects unreadable or invalid rubric files. */
export async function loadRubric(ref: string, read: typeof readText = readText): Promise<Rubric | string> {
  // why: file extensions distinguish local documents from stored ids without probing the filesystem.
  if (/\.(ya?ml|json)$/i.test(ref)) return loadRubricText(await read(ref));
  return ref; // stored id
}

/** Loads a rubric and applies optional mock overrides; rejects invalid or inaccessible files. */
export async function loadCommandRubric(ref: string, mock?: boolean, read: typeof readText = readText): Promise<Rubric | string> {
  const rubric = await loadRubric(ref, read);
  return mock && typeof rubric !== "string" ? mockify(rubric) : rubric;
}
