/**
 * Registers the retry command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { Engine, FileStore, MemoryQueue } from "@verdict-ai/core";
import { Command } from "commander";

import { dataDir, remote } from "../remote.js";
import { renderReport } from "../report.js";

/** Registers retry operations; handler failures propagate to the transport error boundary. */
export function registerRetry(program: Command) {
  program.command("retry <evaluationId>").description("retry a failed evaluation").action(async id => {
    const api = remote();
    if (api) { await api.evaluations.retry(id); console.log(renderReport(await api.evaluations.wait(id))); return; }
    const queue = new MemoryQueue();
    const engine = new Engine({ store: new FileStore(dataDir()), queue, ingest: { allowLocalFiles: true } });
    queue.engine = engine;
    await engine.retryEvaluation(id);
    // Keep the CLI alive while unref'd retry timers are pending.
    const keepAlive = setInterval(() => { }, 1000);
    try { await queue.drain(); } finally { clearInterval(keepAlive); }
    console.log(renderReport((await engine.store.getEvaluation(id))!));
  });

}
