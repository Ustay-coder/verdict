/**
 * Registers the tasks command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { Command } from "commander";

import { localEngine, remote } from "../remote.js";

/** Registers tasks operations; handler failures propagate to the transport error boundary. */
export function registerTasks(program: Command) {
  program.command("tasks").description("list criteria waiting on human raters").option("--rater <id>").action(async (o: { rater?: string }) => {
    const api = remote();
    const tasks = api ? (await api.tasks.list(o.rater)).data : (await localEngine().store.listEvaluations({ status: "pending_human" })).flatMap((e) => e.pendingTasks.map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t })));
    for (const t of tasks) console.log(`${t.evaluationId}\t${t.criterionId}\t${t.raterId ?? (t.allowedRaters ? t.allowedRaters.join("|") : "anyone")}\t${t.rubric}${t.subject ? ` / ${t.subject}` : ""}${t.instructions ? `\n    ${t.instructions}` : ""}`);
    if (!tasks.length) console.log("no pending human tasks");
  });

}
