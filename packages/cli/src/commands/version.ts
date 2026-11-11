/**
 * Registers `verdict version`: freeze rubric files into immutable versions, inspect them, export one exactly, and
 * verify that committed rubric files still match `verdict.lock`.
 */
import { freezeRubric, loadRubricText, rubricToYaml } from "@verdict-ai/core";
import { Command } from "commander";
import { dirname, resolve } from "node:path";

import { lockFrozen, readLock } from "../versions/lock.js";
import { renderVersion } from "../versions/render.js";
import { resolveVersion, versionDefaults, workspace, type VersionDependencies } from "../versions/workspace.js";

interface LockOption { lock?: string }

/** Registers version operations; failures reach the CLI failure handler. */
export function registerVersion(program: Command, deps: VersionDependencies = versionDefaults) {
  const version = program.command("version").description("immutable rubric versions (content-addressed) and verdict.lock");

  version.command("freeze <file>").description("freeze a rubric file into a version and record it in verdict.lock")
    .option("--lock <path>", "lock file", "verdict.lock").option("--json")
    .action(async (file: string, o: LockOption & { json?: boolean }) => {
      const ws = workspace(deps, o);
      const { version: v } = await resolveVersion(ws, file);
      await lockFrozen(deps.lockIo, ws.lockPath, file, v);
      if (o.json) { deps.out(JSON.stringify(v, null, 2)); return; }
      for (const line of renderVersion(v)) deps.out(line);
    });

  version.command("show <id>").description("show a stored version").option("--json").action(async (id: string, o: { json?: boolean }) => {
    const { version: v } = await resolveVersion(workspace(deps), id);
    if (o.json) { deps.out(JSON.stringify(v, null, 2)); return; }
    for (const line of renderVersion(v)) deps.out(line);
  });

  version.command("list").description("list stored versions, newest first").option("--rubric <key>", "only this rubric's versions").action(async (o: { rubric?: string }) => {
    for (const v of await workspace(deps).store.listRubricVersions({ rubricKey: o.rubric })) {
      deps.out(`${v.id}\t${v.createdAt}\t${v.rubricKey}${v.parentVersionId ? `\t← ${v.parentVersionId}` : ""}`);
    }
  });

  version.command("export <id>").description("write a version's exact rubric as YAML (no secrets: judges reference env vars)")
    .option("-o, --out <file>", "write to a file instead of stdout").option("--force", "replace an existing file")
    .action(async (id: string, o: { out?: string; force?: boolean }) => {
      const { version: v } = await resolveVersion(workspace(deps), id);
      const text = `# ${v.id} — exported by verdict; \`verdict version freeze\` on this file gives the same id.\n${rubricToYaml(v.rubric)}`;
      if (!o.out) { deps.out(text); return; }
      await deps.writeNew(o.out, text, o.force);
      deps.out(`wrote ${o.out} (${v.id})`);
    });

  version.command("verify").description("check that every rubric file in verdict.lock still freezes to its locked version (exit 1 if not)")
    .option("--lock <path>", "lock file", "verdict.lock")
    .action(async (o: LockOption) => {
      const lockPath = o.lock ?? "verdict.lock";
      const lock = await readLock(deps.lockIo, lockPath);
      if (!Object.keys(lock.rubrics).length) { deps.out(`${lockPath} lists no rubric files; \`verdict version freeze <file>\` adds one`); return; }
      let bad = 0;
      for (const [file, entry] of Object.entries(lock.rubrics)) {
        const line = await verifyEntry(deps, lockPath, file, entry.version);
        if (!line.ok) bad++;
        deps.out(line.text);
      }
      if (bad) deps.fail(`${bad} rubric file(s) no longer match verdict.lock; run \`verdict version freeze\` after reviewing the change`);
    });
}

async function verifyEntry(deps: VersionDependencies, lockPath: string, file: string, locked: string | undefined): Promise<{ ok: boolean; text: string }> {
  if (!locked) return { ok: false, text: `✗ ${file}: forked but never frozen` };
  const path = resolve(dirname(resolve(lockPath)), file);
  let text: string;
  try { text = await deps.readText(path); }
  catch { return { ok: false, text: `✗ ${file}: missing (locked ${locked})` }; }
  const current = await freezeRubric(loadRubricText(text));
  return current.id === locked ? { ok: true, text: `✓ ${file}: ${locked}` } : { ok: false, text: `✗ ${file}: now ${current.id}, locked ${locked}` };
}
