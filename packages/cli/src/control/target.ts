/**
 * Which server and project the management commands talk to (docs/design/control-plane.md §8.1). Each is read from the
 * command's option, then the environment, then the repository's verdict.yaml; the server falls back to the most recent
 * sign-in. The key is VERDICT_HUB_KEY, else the sign-in saved for that server. VERDICT_API_URL plays no part: that
 * setting moves evaluation to a server, and these commands keep evaluation here and send versions and numbers only.
 */
import { CONTROL_NAME, ValidationError } from "@verdict-ai/core";
import { VerdictError, type Verdict } from "@verdict-ai/sdk";

import { hubTarget } from "../hub/credentials.js";
import { hubClient, type HubDependencies } from "../hub/deps.js";
import { findConfig } from "./config.js";

export interface TargetOptions { hub?: string; project?: string; org?: string }
export interface ServerTarget { client: Verdict; server: string }
export interface ControlTarget extends ServerTarget { project: string }

const config = (deps: HubDependencies) => findConfig(deps.lockIo, (deps.cwd ?? (() => process.cwd()))());

/**
 * The organization a request is about, on servers where one key reaches several: option, environment, verdict.yaml.
 * Unset means the server's default for the key (a person's own organization); servers without organizations ignore it.
 */
function organization(deps: HubDependencies, o: Pick<TargetOptions, "org">, found: { org?: string } | undefined): string | undefined {
  const org = o.org || deps.env.VERDICT_ORG || found?.org;
  if (org && !CONTROL_NAME.test(org)) throw new ValidationError(`organization name "${org}": use lowercase letters, digits and dashes`);
  return org || undefined;
}

/** The server alone, for commands that are not about one project. */
export async function serverTarget(deps: HubDependencies, o: Pick<TargetOptions, "hub" | "org">): Promise<ServerTarget> {
  const found = await config(deps);
  const target = await hubTarget(deps.credentials, deps.env, o.hub, found?.server);
  return { client: hubClient(deps, target.hub, target.apiKey, organization(deps, o, found)), server: target.hub };
}

export async function controlTarget(deps: HubDependencies, o: TargetOptions): Promise<ControlTarget> {
  const found = await config(deps);
  const project = o.project || deps.env.VERDICT_PROJECT || found?.project;
  if (!project) throw new ValidationError("no project: pass --project <name>, set VERDICT_PROJECT, or add `project: <name>` to verdict.yaml");
  if (!CONTROL_NAME.test(project)) throw new ValidationError(`project name "${project}": use lowercase letters, digits and dashes`);
  const target = await hubTarget(deps.credentials, deps.env, o.hub, found?.server);
  return { client: hubClient(deps, target.hub, target.apiKey, organization(deps, o, found)), server: target.hub, project };
}

/** The options every management command takes to say where it works. */
export function addTargetOptions<T extends { option(flags: string, description?: string): T }>(command: T, withProject = true): T {
  const base = withProject ? command.option("--project <name>", "project (or VERDICT_PROJECT, or verdict.yaml)") : command;
  return base.option("--hub <url>", "server (or VERDICT_HUB_URL, verdict.yaml, else the latest sign-in)")
    .option("--org <name>", "organization on that server (or VERDICT_ORG, or verdict.yaml; default: your own)");
}

/** Runs a request; a rejected key becomes an instruction instead of a bare 401. */
export async function asking<T>(target: ServerTarget, request: (client: Verdict) => Promise<T>): Promise<T> {
  try { return await request(target.client); }
  catch (e) {
    if (e instanceof VerdictError && e.status === 401) throw new ValidationError(`${target.server} did not accept the key: run \`verdict login --hub ${target.server}\` or set VERDICT_HUB_KEY`);
    throw e;
  }
}

/** Asks before a change unless `--yes`; without a terminal there is no one to ask, so `--yes` is required. */
export async function confirmed(deps: HubDependencies, yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  if (!deps.interactive()) throw new ValidationError("pass --yes to do this without a terminal (what would change is shown above)");
  return deps.confirm(question);
}
