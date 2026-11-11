/**
 * The name a rubric is kept under on a server (docs/design/control-plane.md C2): `--name`, else the name recorded in
 * verdict.lock, else the rubric's own `id`, else its file name. Services ask for a rubric by this name.
 */
import { CONTROL_NAME, ValidationError, type RubricVersion } from "@verdict-ai/core";
import { basename } from "node:path";

import { lockKey, readLock } from "../versions/lock.js";
import type { Workspace } from "../versions/workspace.js";

/** Lowercase letters, digits and dashes; empty when nothing usable is left. */
export function slug(text: string | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
}

export interface NamedSide { version: RubricVersion; file?: string }

/** The name for one rubric; several sides (the head and base of a comparison) are tried in order. */
export async function rubricNameFor(ws: Workspace, flag: string | undefined, sides: NamedSide[]): Promise<string> {
  if (flag !== undefined) {
    if (!CONTROL_NAME.test(flag)) throw new ValidationError(`--name "${flag}": use lowercase letters, digits and dashes`);
    return flag;
  }
  const lock = await readLock(ws.deps.lockIo, ws.lockPath);
  for (const side of sides) {
    // A stored version has no file here; the lock may still know which file froze to it.
    const key = side.file ? lockKey(ws.lockPath, side.file) : Object.keys(lock.rubrics).find((k) => lock.rubrics[k]?.version === side.version.id);
    const candidates = [lock.rubrics[key ?? ""]?.name, slug(side.version.rubric.id), slug(basename(side.file ?? key ?? "").replace(/\.(ya?ml|json)$/i, ""))];
    const found = candidates.find((c) => c && CONTROL_NAME.test(c));
    if (found) return found;
  }
  throw new ValidationError("cannot tell which name this rubric is kept under; pass --name <name>");
}
