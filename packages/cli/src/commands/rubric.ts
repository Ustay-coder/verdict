import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { FileAccessError, loadRubricText } from "@verdict-ai/core";
import { Command } from "commander";
import { writeFile } from "node:fs/promises";

import { readText } from "../files.js";
import { starterRubric } from "../starter.js";

/** Registers rubric operations; handler failures propagate to the transport error boundary. */
export function registerRubric(program: Command, deps: CommandDependencies & { readText: typeof readText; writeFile: typeof writeRubric } = { ...commandDefaults, readText, writeFile: writeRubric }) {
  const rubricCmd = program.command("rubric").description("manage rubrics");
  rubricCmd.command("init [file]").description("write a starter rubric").action(async (file = "rubric.yaml") => { await deps.writeFile(file, starterRubric); deps.out(`wrote ${file}`); });
  rubricCmd.command("validate <file>").description("validate a rubric file").action(async (file) => {
    try { const r = loadRubricText(await deps.readText(file)); deps.out(`OK: ${r.name} — ${r.criteria.length} criteria, aggregation=${r.aggregation.method}`); }
    catch (e) { deps.fail(`INVALID: ${e instanceof Error ? e.message : String(e)}`); }
  });
  rubricCmd.command("push <file>").description("store a rubric (remote API if VERDICT_API_URL is set, else local .verdict/)").action(async (file) => {
    const r = loadRubricText(await deps.readText(file));
    const api = deps.remote();
    const stored = api ? await api.rubrics.create(r) : await deps.engine().createRubric(r);
    deps.out(stored.id);
  });
  rubricCmd.command("list").action(async () => {
    const api = deps.remote();
    const list = api ? (await api.rubrics.list()).data : await deps.engine().store.listRubrics();
    for (const r of list) deps.out(`${r.id}\t${r.name}\t${r.criteria.length} criteria`);
  });

}

async function writeRubric(path: string, text: string): Promise<void> {
  try { await writeFile(path, text); }
  catch (cause) { throw new FileAccessError(path, "write rubric", cause); }
}
