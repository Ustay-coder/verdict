/**
 * Registers the get command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { fail } from "../fail.js";
import { Command } from "commander";

import { localEngine, remote } from "../remote.js";
import { renderReport } from "../report.js";

/** Registers get operations; handler failures propagate to the transport error boundary. */
export function registerGet(program: Command) {
  program.command("get <id>").description("show a stored evaluation").option("--json").action(async (id: string, o: GetOptions) => {
    const api = remote();
    const ev = api ? ((await api.evaluations.get(id))) : await localEngine().store.getEvaluation(id);
    if (!ev) { fail("evaluation not found; verify its id and data directory"); return; }
    console.log(o.json ? JSON.stringify(ev, null, 2) : renderReport(ev));
  });

}

interface GetOptions { json?: boolean; evidence?: boolean; }
