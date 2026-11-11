/**
 * Shared plumbing for the version commands: resolves references (a rubric file, `rv_…`, `run_…`), freezes datasets,
 * and loads runs with their evaluations. Everything runs on the local engine; files stay on this machine.
 */
import {
  createDatasetVersion, FileAccessError, freezeRubric, hasVersions, loadRubricText, parseGoldSet, ValidationError,
  type DatasetVersion, type Engine, type Evaluation, type Rubric, type RubricVersion, type Run, type VersionStore,
} from "@verdict-ai/core";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { readText } from "../files.js";
import { mockify } from "../mock.js";
import { lockKey, readLock, type LockIo } from "./lock.js";

export interface VersionDependencies extends CommandDependencies {
  readText: (path: string) => Promise<string>;
  readBytes: (path: string) => Promise<Uint8Array>;
  lockIo: LockIo;
  /** Writes a new file; refuses to replace an existing one unless `overwrite`. */
  writeNew: (path: string, text: string, overwrite?: boolean) => Promise<void>;
  /** Sets the process exit code without printing (gates such as `diff --fail-on`). */
  exitCode: (code: number) => void;
  /** Notes for people (stderr), kept out of stdout so `--json` output stays parseable. */
  warn: (line: string) => void;
}

export const versionDefaults: VersionDependencies = {
  ...commandDefaults, readText, readBytes, writeNew, exitCode: (code) => { process.exitCode = code; }, warn: (line) => console.error(line),
  lockIo: { read: readOptional, write: writeAtomic },
};

/** One engine per command, so runs and their evaluations land in the same store. */
export interface Workspace { engine: Engine; store: VersionStore; deps: VersionDependencies; lockPath: string; mock: boolean }

/** `remoteOk`: commands that only read rubric files and the lock work whatever VERDICT_API_URL says. */
export function workspace(deps: VersionDependencies, opts: { lock?: string; mock?: boolean } = {}, remoteOk = false): Workspace {
  if (!remoteOk && deps.remote()) throw new ValidationError("version commands run on the local engine; unset VERDICT_API_URL");
  const engine = deps.engine();
  if (!hasVersions(engine.store)) throw new ValidationError("the configured store cannot keep rubric versions");
  return { engine, store: engine.store, deps, lockPath: opts.lock ?? "verdict.lock", mock: !!opts.mock };
}

export const isRubricFile = (ref: string) => /\.(ya?ml|json)$/i.test(ref);

/**
 * Freezes a rubric file (taking its parent and note from the lock) or loads a stored version. With `mock`, providers
 * are swapped for mocks first — a different binding, so a different version, by design.
 */
export async function resolveVersion(ws: Workspace, ref: string): Promise<{ version: RubricVersion; file?: string }> {
  if (isRubricFile(ref)) {
    const rubric = loadRubricText(await ws.deps.readText(ref));
    const entry = (await readLock(ws.deps.lockIo, ws.lockPath)).rubrics[lockKey(ws.lockPath, ref)];
    const parent = entry?.parent ? await ws.store.getRubricVersion(entry.parent) : undefined;
    return { version: await keep(ws, ws.mock ? mockify(rubric) : rubric, parent, entry?.note), file: ref };
  }
  const stored = await ws.store.getRubricVersion(ref);
  if (!stored) throw new ValidationError(`no rubric version ${ref} in this data directory`);
  return { version: ws.mock ? await keep(ws, mockify(stored.rubric)) : stored };
}

async function keep(ws: Workspace, rubric: Rubric, parent?: RubricVersion, note?: string): Promise<RubricVersion> {
  return remember(ws, await freezeRubric(rubric, { ...(parent ? { parent } : {}), ...(note ? { note } : {}) }));
}

/** Stores a version unless one with its id is already there, and returns the stored one. */
export async function remember(ws: Workspace, version: RubricVersion): Promise<RubricVersion> {
  // Content-derived ids make this idempotent: re-freezing keeps the first createdAt.
  const existing = await ws.store.getRubricVersion(version.id);
  if (existing) return existing;
  await ws.store.putRubricVersion(version);
  return version;
}

/** Freezes a gold file into a dataset version; file inputs are identified by their bytes. */
export async function resolveDataset(ws: Workspace, path: string): Promise<DatasetVersion> {
  const items = parseGoldSet(await ws.deps.readText(path), dirname(resolve(path)));
  const dataset = await createDatasetVersion(items, { name: basename(path), readFile: ws.deps.readBytes });
  if (!(await ws.store.getDatasetVersion(dataset.id))) await ws.store.putDatasetVersion(dataset);
  return (await ws.store.getDatasetVersion(dataset.id)) ?? dataset;
}

export interface LoadedRun { run: Run; version: RubricVersion; evaluations: Evaluation[] }

export async function loadRun(ws: Workspace, id: string): Promise<LoadedRun> {
  const run = await ws.store.getRun(id);
  if (!run) throw new ValidationError(`no run ${id} in this data directory`);
  const version = await ws.store.getRubricVersion(run.rubricVersionId);
  if (!version) throw new ValidationError(`run ${id} refers to rubric version ${run.rubricVersionId}, which is missing`);
  const evaluations = (await Promise.all(run.cases.map((c) => ws.engine.store.getEvaluation(c.evaluationId)))).filter((e): e is Evaluation => !!e);
  return { run, version, evaluations };
}

/** The newest stored run of `version` over the same case inputs that did not fail outright. */
export async function latestRun(ws: Workspace, version: RubricVersion, dataset: DatasetVersion): Promise<Run | undefined> {
  const runs = await ws.store.listRuns({ rubricVersionId: version.id });
  return runs.find((r) => r.fingerprint.casesHash === dataset.casesHash && r.status !== "failed");
}

async function readBytes(path: string): Promise<Uint8Array> {
  try { return new Uint8Array(await readFile(path)); }
  catch (cause) { throw new FileAccessError(path, "read", cause); }
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FileAccessError(path, "read", cause);
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(dirname(resolve(path)), { recursive: true });
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (cause) { throw new FileAccessError(path, "write", cause); }
}

async function writeNew(path: string, text: string, overwrite = false): Promise<void> {
  if (!overwrite && (await readOptional(path)) !== undefined) throw new ValidationError(`${path} exists; pass --force to replace it`);
  await writeAtomic(path, text);
}
