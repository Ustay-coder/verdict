/**
 * `verdict.yaml`: which project a repository's rubrics belong to, and optionally which server keeps it and which
 * organisation on that server (docs/design/control-plane.md C18). Committed, so everyone and CI use the same project. Looked for from the working
 * directory upwards.
 */
import { CONTROL_NAME, ValidationError } from "@verdict-ai/core";
import { dirname, join } from "node:path";
import YAML from "yaml";

import type { LockIo } from "../versions/lock.js";

export interface ProjectConfig { path: string; project?: string; server?: string; org?: string }

export async function findConfig(io: Pick<LockIo, "read">, from: string): Promise<ProjectConfig | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    const path = join(dir, "verdict.yaml");
    const text = await io.read(path);
    if (text !== undefined) return parseConfig(path, text);
    if (dirname(dir) === dir) return undefined;
  }
}

function parseConfig(path: string, text: string): ProjectConfig {
  const data: unknown = YAML.parse(text) ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new ValidationError(`${path}: expected \`project: <name>\` and optionally \`server: <url>\` and \`org: <name>\``);
  const { project, server, org } = data as Record<string, unknown>;
  if (project !== undefined && (typeof project !== "string" || !CONTROL_NAME.test(project))) throw new ValidationError(`${path}: project must be lowercase letters, digits and dashes`);
  if (server !== undefined && (typeof server !== "string" || !/^https?:\/\//.test(server))) throw new ValidationError(`${path}: server must be an http(s) URL`);
  if (org !== undefined && (typeof org !== "string" || !CONTROL_NAME.test(org))) throw new ValidationError(`${path}: org must be lowercase letters, digits and dashes`);
  return { path, ...(project ? { project } : {}), ...(server ? { server } : {}), ...(org ? { org } : {}) };
}
