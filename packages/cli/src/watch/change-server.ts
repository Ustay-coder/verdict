/**
 * The change-test API of `verdict watch`: views are read from the store, and the few writes (a test, a revision, a
 * trial, a follow-up) go through core. The rest of the watch server only reads, so writes are guarded on their own:
 * they need the token the page was served with — a page on another origin cannot read it — and are off altogether
 * when the server is not bound to this machine. A trial runs in this process; its progress is whatever the store says.
 */
import {
  addFollowUp, changeId, createChangeTest, createDatasetVersion, createTrial, executeTrial, freezeRubric, interruptTrial, loadRubricText, parseChangeRequest, resolveFollowUp,
  reverifyTrial, reviseExpectations, seedChangeDemo, ValidationError, type ChangeWorkbench, type Engine, type Trial,
} from "@verdict-ai/core";
import type { IncomingMessage, ServerResponse } from "node:http";
import { changeIndex, testView, trialView } from "./change-state.js";

export interface ChangeContext {
  engine: Engine; store: ChangeWorkbench;
  /** False: every write answers 403 with `readOnlyReason`. */
  writable: boolean; readOnlyReason?: string;
  token: string;
  env: (name: string) => string | undefined;
  /** Trials this process is running, by id. */
  active: Map<string, AbortController>;
  /** The trial being created, if any: the next request waits for it. */
  starting: Promise<unknown>;
  runner: string;
  /** Whether the process a trial names as its runner is still there. */
  alive: (runner: string | undefined) => boolean;
}

const MAX_BODY_BYTES = 2_000_000;

class Refused extends Error { status = 403; }

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("the request is too large");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new ValidationError("the request body is not JSON"); }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function sameOrigin(origin: string, host: string | undefined): boolean {
  try { return new URL(origin).host === host; }
  catch { return false; }
}

/**
 * A write must come from the page this server served, on this machine: the page's token, the same origin when the
 * browser names one, and a local host name — a foreign name that merely resolves here (DNS rebinding) is refused.
 */
function guardWrite(ctx: ChangeContext, req: IncomingMessage) {
  if (!ctx.writable) throw new Refused(ctx.readOnlyReason ?? "this page is read-only");
  if (req.headers["x-verdict-watch"] !== ctx.token) throw new Refused("this request did not come from the page verdict watch served");
  const host = req.headers.host;
  if (!LOCAL_HOSTS.has((host ?? "").replace(/:\d+$/, ""))) throw new Refused("requests addressed to another host name are refused");
  if (req.headers.origin !== undefined && !sameOrigin(req.headers.origin, host)) throw new Refused("requests from another origin are refused");
}

/** Starts the evaluations without waiting for them; the page polls the trial. A failure is recorded on the trial. */
function runInBackground(ctx: ChangeContext, trial: Trial) {
  const abort = new AbortController();
  ctx.active.set(trial.id, abort);
  void executeTrial(ctx.engine, ctx.store, trial.id, { signal: abort.signal, runner: ctx.runner })
    .catch((cause) => interruptTrial(ctx.store, trial.id, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined))
    .finally(() => ctx.active.delete(trial.id));
}

/** A trial marked queued or running that nobody is running: its runner stopped. Ended as cancelled, results kept. */
async function reap(ctx: ChangeContext, trialId: string) {
  const trial = await ctx.store.getTrial(trialId);
  if (!trial || (trial.status !== "queued" && trial.status !== "running") || ctx.active.has(trial.id) || ctx.alive(trial.runner)) return;
  // A queued trial with no runner yet was just created by another process; give it a moment before calling it lost.
  if (!trial.runner && Date.now() - Date.parse(trial.createdAt) < 15_000) return;
  await interruptTrial(ctx.store, trial.id, "interrupted: the process that was running this trial stopped");
}

function readRubric(text: string) {
  try { return loadRubricText(text); }
  catch (cause) { throw new ValidationError(cause instanceof Error ? cause.message : String(cause)); }
}

type Write = (ctx: ChangeContext, body: unknown) => Promise<unknown>;

const WRITES: Record<string, Write> = {
  demo: async (ctx) => ({ tests: (await seedChangeDemo(ctx.engine, ctx.store)).tests.map((t) => ({ testId: t.test.id, trialId: t.trial.id, created: t.created })) }),
  tests: async (ctx, body) => ({ testId: (await createChangeTest(ctx.store, parseChangeRequest("tests", body))).id }),
  revisions: async (ctx, body) => {
    const { testId, ...input } = parseChangeRequest("revisions", body);
    return { revision: (await reviseExpectations(ctx.store, testId, input)).revisions.at(-1)!.revision };
  },
  trials: async (ctx, body) => {
    const { testId, candidateVersionId, ...opts } = parseChangeRequest("trials", body);
    // One at a time: two requests arriving together must not both find "no trial running" and both start one.
    const starting = ctx.starting.then(() => createTrial(ctx.store, testId, candidateVersionId, opts));
    ctx.starting = starting.catch(() => undefined);
    const { trial, existing } = await starting;
    if (!existing) runInBackground(ctx, trial);
    return { trialId: trial.id, existing };
  },
  cancel: async (ctx, body) => {
    const { trialId } = parseChangeRequest("cancel", body);
    const running = ctx.active.get(trialId);
    if (running) running.abort();
    else await reap(ctx, trialId);
    return { trialId, cancelling: !!running };
  },
  reverify: async (ctx, body) => {
    const { trialId, revision } = parseChangeRequest("reverify", body);
    return { verificationId: (await reverifyTrial(ctx.store, trialId, revision ? { revision } : {})).verifications.at(-1)!.id };
  },
  "follow-ups": async (ctx, body) => {
    const input = parseChangeRequest("followUps", body);
    if (input.resolve) return { followUps: (await resolveFollowUp(ctx.store, input.testId, input.resolve)).followUps };
    if (!input.caseId || !input.trialId) throw new ValidationError("a follow-up needs caseId and trialId");
    return { followUps: (await addFollowUp(ctx.store, input.testId, { caseId: input.caseId, trialId: input.trialId, ...(input.note ? { note: input.note } : {}) })).followUps };
  },
  versions: async (ctx, body) => {
    const text = parseChangeRequest("versions", body).rubric;
    // A rubric that does not parse is the sender's mistake, not the server's.
    const version = await freezeRubric(readRubric(text));
    if (!(await ctx.store.getRubricVersion(version.id))) await ctx.store.putRubricVersion(version);
    return { versionId: version.id };
  },
  documents: async (ctx, body) => {
    const input = parseChangeRequest("documents", body);
    const dataset = await createDatasetVersion(input.documents.map((d) => ({ name: d.name, inputs: [{ type: "text" as const, text: d.text }], human: {} })), { name: input.name?.trim() || `${input.documents.length} pasted document${input.documents.length === 1 ? "" : "s"}` });
    if (!(await ctx.store.getDatasetVersion(dataset.id))) await ctx.store.putDatasetVersion(dataset);
    return { datasetVersionId: dataset.id };
  },
};

async function read(ctx: ChangeContext, name: string, q: URLSearchParams): Promise<unknown> {
  const opts = { writable: ctx.writable, env: ctx.env };
  if (name === "index") return { ...(await changeIndex(ctx.store, opts)), ...(ctx.writable ? {} : { notice: ctx.readOnlyReason }) };
  if (name === "test") return testView(ctx.store, changeId(q.get("id"), "test id"), { ...opts, ...(q.get("candidate") ? { candidate: changeId(q.get("candidate"), "candidate") } : {}) });
  if (name === "trial") {
    const trialId = changeId(q.get("id"), "trial id");
    await reap(ctx, trialId);
    return trialView(ctx.store, trialId, { ...opts, ...(q.get("verification") ? { verification: q.get("verification")! } : {}) });
  }
  return undefined;
}

/** Answers `/api/change/…`; false when the path is not one of them. Errors carry their own status. */
export async function handleChange(ctx: ChangeContext, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const name = /^\/api\/change\/([a-z-]+)$/.exec(url.pathname)?.[1];
  if (!name) return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body)); return true; };
  try {
    if (req.method === "GET") {
      const view = await read(ctx, name, url.searchParams);
      return view === undefined ? send(404, { error: "not found" }) : send(200, view);
    }
    const write = req.method === "POST" ? WRITES[name] : undefined;
    if (!write) return send(404, { error: "not found" });
    guardWrite(ctx, req);
    return send(200, await write(ctx, await readJson(req)));
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    return send(status >= 400 && status < 600 ? status : 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
