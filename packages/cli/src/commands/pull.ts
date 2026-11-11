/**
 * Registers `verdict pull`: copy a rubric exactly, as a file to edit or keep.
 *   - `hub:owner/slug[@rv_…]` — a published card, with its public cases; where it came from (and its licence) goes
 *     into verdict.lock;
 *   - `<name>` with `--env`, `<name>@latest`, `<name>@rv_…` — a version your team's server keeps (C28).
 * Either way the written file freezes to the same version id, checked before anything is written.
 */
import { freezeRubric, isHubRef, loadRubricText, rubricToYaml, ValidationError } from "@verdict-ai/core";
import { Command } from "commander";

import { fetchServerVersion, serverRef, type ServerRefOptions } from "../control/server-ref.js";
import { hubDefaults, type HubDependencies } from "../hub/deps.js";
import { casesJsonl, casesPath, fetchCard, provenanceHeader } from "../hub/pull.js";
import { lockFrozen, updateLock } from "../versions/lock.js";
import { remember, workspace, type Workspace } from "../versions/workspace.js";

export interface PullOptions extends ServerRefOptions { to?: string; cases?: string | boolean; force?: boolean; lock?: string }

/** Registers pull; failures reach the CLI failure handler. */
export function registerPull(program: Command, deps: HubDependencies = hubDefaults) {
  program.command("pull <ref>").description("copy a rubric exactly into a file: a published hub card (hub:owner/slug[@rv_…]) with its public cases, or a version your team's server keeps (<name> with --env, <name>@latest, <name>@rv_…)")
    .option("--to <file>", "rubric file to write (default: <slug>.yaml or <name>.yaml)")
    .option("--cases <file>", "where to write a card's public cases (default: next to the rubric file)").option("--no-cases", "do not write the public cases")
    .option("--hub <url>", "server (default: VERDICT_HUB_URL, verdict.yaml, else the one you signed in to)")
    .option("--env <name>", "with a rubric name: the version this environment runs").option("--project <name>", "project (or VERDICT_PROJECT, or verdict.yaml)")
    .option("--org <name>", "organization on that server (or VERDICT_ORG, or verdict.yaml; default: your own)")
    .option("--force", "replace existing files").option("--lock <path>", "lock file", "verdict.lock")
    .action(async (ref: string, o: PullOptions) => {
      const ws = workspace(deps, o);
      if (!isHubRef(ref)) return pullFromProject(deps, ws, ref, o);
      const card = await fetchCard(deps, ref, o.hub);
      const to = o.to ?? `${card.publication.slug}.yaml`;
      const text = provenanceHeader(card, "pulled") + rubricToYaml(card.version.rubric);
      // The written file must freeze back to the version it claims to be.
      const reread = await freezeRubric(loadRubricText(text));
      if (reread.id !== card.version.id) throw new ValidationError(`the written rubric would freeze to ${reread.id}, not ${card.version.id}; nothing was written`);
      await deps.writeNew(to, text, o.force);
      await remember(ws, card.version);
      await updateLock(deps.lockIo, ws.lockPath, to, () => ({
        version: card.version.id, contentHash: card.version.contentHash, judgmentHash: card.version.judgmentHash,
        origin: { hub: card.hub, ref: card.ref, license: card.publication.license },
      }));
      deps.out(`wrote ${to} (${card.ref}, ${card.publication.license})`);
      await writeCases(deps, card.publication, casesPath(to, o.cases), o.force);
    });
}

/** A version the team's server keeps, as a file: to edit into the next version, or to commit beside the code that uses it. */
async function pullFromProject(deps: HubDependencies, ws: Workspace, ref: string, o: PullOptions): Promise<void> {
  const named = serverRef(ref, o);
  if (!named) throw new ValidationError(`${ref}: expected a hub card (hub:owner/slug[@rv_…]) or a rubric on your team's server: <name> with --env <environment>, <name>@latest or <name>@rv_…`);
  const { version, said } = await fetchServerVersion(deps, ws.store, named, o);
  const to = o.to ?? `${named.name}.yaml`;
  const text = `# pulled by verdict — ${said}; \`verdict version freeze\` on this file gives the same id.\n${rubricToYaml(version.rubric)}`;
  // The written file must freeze back to the version it claims to be.
  const reread = await freezeRubric(loadRubricText(text));
  if (reread.id !== version.id) throw new ValidationError(`the written rubric would freeze to ${reread.id}, not ${version.id}; nothing was written`);
  await deps.writeNew(to, text, o.force);
  await lockFrozen(deps.lockIo, ws.lockPath, to, version);
  // The name it has on the server stays with the file, so pushing an edited copy goes back under the same name.
  await updateLock(deps.lockIo, ws.lockPath, to, ({ name: _previous, ...rest }) => ({ name: named.name, ...rest }));
  deps.out(`wrote ${to} (${said})`);
}

/** Writes a card's public cases when it has any; shared with `verdict fork hub:…`. */
export async function writeCases(deps: HubDependencies, publication: Parameters<typeof casesJsonl>[0], path: string | undefined, force?: boolean) {
  if (!path || !publication.cases.length) return;
  await deps.writeNew(path, casesJsonl(publication), force);
  deps.out(`wrote ${path} (${publication.cases.length} public case(s)); \`verdict run -r <rubric> -d ${path}\` checks them yourself`);
}
