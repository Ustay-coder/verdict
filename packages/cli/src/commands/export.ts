/**
 * Registers the export command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { fail } from "../fail.js";
import { Command } from "commander";
import YAML from "yaml";

import { localEngine } from "../remote.js";

/** Registers export operations; handler failures propagate to the transport error boundary. */
export function registerExport(program: Command) {
  program.command("export <id>").description("dump an evaluation as YAML").action(async (id) => {
    const ev = await localEngine().store.getEvaluation(id);
    if (!ev) { fail("evaluation not found; verify its id and data directory"); return; }
    console.log(YAML.stringify({ ...ev, evidence: ev.evidence.map((e) => ({ ...e, text: `${e.text.slice(0, 200)}…` })) }));
  });

}
