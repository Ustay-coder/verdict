/**
 * Registers `verdict project` and `verdict env`: the projects on a Verdict server, their environments, which rubric
 * version each environment runs, and the history of those changes (docs/design/control-plane.md §8.2).
 */
import type { PromotionEventView } from "@verdict-ai/sdk";
import { Command } from "commander";

import { applyChanges, planChanges, pointersOf } from "../control/pointers.js";
import { addTargetOptions, asking, confirmed, controlTarget, serverTarget, type TargetOptions } from "../control/target.js";
import { hubDefaults, type HubDependencies } from "../hub/deps.js";

interface Common extends TargetOptions { json?: boolean; yes?: boolean }

/** Registers project commands; failures reach the CLI failure handler. */
export function registerProject(program: Command, deps: HubDependencies = hubDefaults) {
  const project = program.command("project").description("projects on a Verdict server: where a team's rubric versions and environments live");

  serverOptions(project.command("create <name>").description("create a project")).action(async (name: string, o: Common) => {
    const target = await serverTarget(deps, o);
    await asking(target, (client) => client.projects.create(name));
    deps.out(`created project ${name} on ${target.server}`);
  });

  serverOptions(project.command("list").description("list the projects this key can see")).option("--json").action(async (o: Common) => {
    const target = await serverTarget(deps, o);
    const { data } = await asking(target, (client) => client.projects.list());
    if (o.json) { deps.out(JSON.stringify(data, null, 2)); return; }
    if (!data.length) deps.out(`no projects on ${target.server} yet; \`verdict project create <name>\` makes one`);
    for (const p of data) deps.out(`${p.name}\t${p.createdAt}`);
  });

  serverOptions(project.command("delete <name>").description("delete a project with its versions, environments, history and reports")).option("-y, --yes", "delete without asking")
    .action(async (name: string, o: Common) => {
      const target = await serverTarget(deps, o);
      deps.out(`project ${name} on ${target.server}: its versions, environments, history and reports would be deleted`);
      if (!(await confirmed(deps, o.yes, `Delete project ${name}?`))) { deps.out("nothing deleted"); return; }
      await asking(target, (client) => client.projects.delete(name));
      deps.out(`deleted project ${name}`);
    });
}

const targetOptions = (command: Command) => addTargetOptions(command);
const serverOptions = (command: Command) => addTargetOptions(command, false);

/** One line of history: when, where, what moved from which version to which, how, by whom and why. */
export function historyLine(e: PromotionEventView): string {
  const who = e.actor ? ` by ${e.actor.name ?? e.actor.id ?? "an unnamed key"}` : "";
  return `${e.at}\t${e.environment}\t${e.name}\t${e.from ?? "(none)"} → ${e.to ?? "(removed)"}\t${e.kind}${who}${e.note ? `\t“${e.note}”` : ""}`;
}

/** Registers environment commands; failures reach the CLI failure handler. */
export function registerEnv(program: Command, deps: HubDependencies = hubDefaults) {
  const env = program.command("env").description("environments of a project: which version of each rubric runs where");

  targetOptions(env.command("create <name>").description("create an environment (for example staging, prod)")).action(async (name: string, o: Common) => {
    const target = await controlTarget(deps, o);
    await asking(target, (client) => client.environments.create(target.project, name));
    deps.out(`created environment ${name} in ${target.project} on ${target.server}`);
  });

  targetOptions(env.command("list").description("list a project's environments")).option("--json").action(async (o: Common) => {
    const target = await controlTarget(deps, o);
    const { data } = await asking(target, (client) => client.environments.list(target.project));
    if (o.json) { deps.out(JSON.stringify(data, null, 2)); return; }
    if (!data.length) deps.out(`no environments in ${target.project} yet; \`verdict env create <name>\` makes one`);
    for (const e of data) deps.out(`${e.name}\t${e.createdAt}`);
  });

  targetOptions(env.command("show <name>").description("show which version of each rubric an environment runs")).option("--json").action(async (name: string, o: Common) => {
    const target = await controlTarget(deps, o);
    const environment = await asking(target, (client) => client.environments.get(target.project, name));
    if (o.json) { deps.out(JSON.stringify(environment, null, 2)); return; }
    if (!environment.pointers.length) deps.out(`${name} runs nothing yet; \`verdict promote <rubric file> --env ${name}\` puts a version there`);
    for (const p of environment.pointers) deps.out(`${p.name}\t${p.versionId}\t${p.updatedAt}`);
  });

  targetOptions(env.command("delete <name>").description("delete an environment and its pointers (its history stays)")).option("-y, --yes", "delete without asking")
    .action(async (name: string, o: Common) => {
      const target = await controlTarget(deps, o);
      deps.out(`environment ${name} in ${target.project} on ${target.server}: services reading it would stop getting versions`);
      if (!(await confirmed(deps, o.yes, `Delete environment ${name}?`))) { deps.out("nothing deleted"); return; }
      await asking(target, (client) => client.environments.delete(target.project, name));
      deps.out(`deleted environment ${name}`);
    });

  registerHistory(env, deps);
}

function registerHistory(env: Command, deps: HubDependencies) {
  targetOptions(env.command("history").description("who changed which pointer, when, from what to what"))
    .option("--env <name>", "only this environment").option("--name <rubric>", "only this rubric").option("--limit <n>", "how many changes, newest first", "20").option("--json")
    .action(async (o: Common & { env?: string; name?: string; limit: string }) => {
      const target = await controlTarget(deps, o);
      const { data } = await asking(target, (client) => client.projects.history(target.project, { environment: o.env, name: o.name, limit: Number(o.limit) }));
      if (o.json) { deps.out(JSON.stringify(data, null, 2)); return; }
      if (!data.length) deps.out("no changes yet");
      for (const e of data) deps.out(historyLine(e));
    });

  targetOptions(env.command("unset <rubric>").description("stop an environment running a rubric (removes the pointer; the version is kept)"))
    .requiredOption("--env <name>", "environment").option("--note <text>", "why").option("-y, --yes", "do it without asking").option("--json")
    .action(async (rubric: string, o: Common & { env: string; note?: string }) => {
      const target = await controlTarget(deps, o);
      const changes = planChanges(deps, o.env, [{ name: rubric, versionId: null }], await pointersOf(target, o.env));
      const [done] = await applyChanges(deps, target, changes, o);
      if (done && !o.json) deps.out(`${o.env} no longer runs ${rubric} (was ${done.expected})`);
    });
}
