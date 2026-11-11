/**
 * `verdict.lock`: which rubric version each rubric file was frozen as, what it was forked from, and the questions and
 * models its last run on that version used. Commit it: `verdict version verify` fails when a file no longer matches
 * its locked version, so what was tested is what ships (docs/design/hub.md X1).
 */
import { dirname, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { RunModel } from "@verdict-ai/core";

export interface LockEntry {
  /** The name this rubric is kept under on a server; services ask for it by this name. */
  name?: string;
  version?: string;
  contentHash?: string;
  judgmentHash?: string;
  parent?: string;
  note?: string;
  /** Where a pulled or forked hub card came from, with its licence (kept so a fork carries its terms). */
  origin?: { hub: string; ref: string; license: string };
  /** The last run of exactly `version`: the questions it sent and the models that answered. */
  verified?: { runId: string; questionsHash: string | null; models: RunModel[] };
}

export interface Lock { lockVersion: 1; rubrics: Record<string, LockEntry> }

const HEADER = "# verdict.lock — written by `verdict version freeze`, `fork`, `run`, `push` and `promote`. Commit it; `verdict version verify` checks it.\n";

/** Reads and writes text files; `read` resolves undefined for a missing file. */
export interface LockIo { read(path: string): Promise<string | undefined>; write(path: string, text: string): Promise<void> }

export async function readLock(io: LockIo, path: string): Promise<Lock> {
  const text = await io.read(path);
  if (text === undefined || !text.trim()) return { lockVersion: 1, rubrics: {} };
  const data: unknown = YAML.parse(text);
  if (!isLock(data)) throw new Error(`${path} is not a valid verdict.lock (expected lockVersion: 1 and a rubrics map of entries)`);
  return data;
}

export async function writeLock(io: LockIo, path: string, lock: Lock): Promise<void> {
  // Sorted keys keep diffs of the committed file small and stable.
  const rubrics = Object.fromEntries(Object.keys(lock.rubrics).sort().map((k) => [k, lock.rubrics[k]]));
  await io.write(path, HEADER + YAML.stringify({ lockVersion: 1, rubrics }, { lineWidth: 0 }));
}

/** The key a rubric file is locked under: its path relative to the lock file, with forward slashes. */
export function lockKey(lockPath: string, file: string): string {
  const rel = relative(dirname(resolve(lockPath)), resolve(file));
  return rel.split(sep).join("/");
}

/** Reads the lock, applies `change` to one file's entry, and writes it back. */
export async function updateLock(io: LockIo, lockPath: string, file: string, change: (entry: LockEntry) => LockEntry): Promise<LockEntry> {
  const lock = await readLock(io, lockPath);
  const key = lockKey(lockPath, file);
  const next = change(lock.rubrics[key] ?? {});
  lock.rubrics[key] = next;
  await writeLock(io, lockPath, lock);
  return next;
}

// Shape check only: entries are written by this module, so a hand-edited lock that parses is trusted field by field.
function isLock(data: unknown): data is Lock {
  if (!data || typeof data !== "object") return false;
  const { lockVersion, rubrics } = data as Record<string, unknown>;
  if (lockVersion !== 1 || !rubrics || typeof rubrics !== "object" || Array.isArray(rubrics)) return false;
  return Object.values(rubrics).every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry));
}
