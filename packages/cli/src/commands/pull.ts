/**
 * Registers `verdict pull hub:owner/slug[@rv_…]`: copy a published card exactly — the rubric file freezes to the same
 * version id — with its public cases, and record where it came from (and its licence) in verdict.lock.
 */
import { freezeRubric, loadRubricText, rubricToYaml, ValidationError } from "@verdict-ai/core";
import { Command } from "commander";

import { hubDefaults, type HubDependencies } from "../hub/deps.js";
import { casesJsonl, casesPath, fetchCard, provenanceHeader } from "../hub/pull.js";
import { updateLock } from "../versions/lock.js";
import { remember, workspace } from "../versions/workspace.js";

export interface PullOptions { to?: string; cases?: string | boolean; hub?: string; force?: boolean; lock?: string }

/** Registers pull; failures reach the CLI failure handler. */
export function registerPull(program: Command, deps: HubDependencies = hubDefaults) {
  program.command("pull <ref>").description("copy a published hub card (hub:owner/slug[@rv_…]) exactly, with its public cases")
    .option("--to <file>", "rubric file to write (default: <slug>.yaml)")
    .option("--cases <file>", "where to write the public cases (default: next to the rubric file)").option("--no-cases", "do not write the public cases")
    .option("--hub <url>", "hub URL (default: VERDICT_HUB_URL or the hub you signed in to)")
    .option("--force", "replace existing files").option("--lock <path>", "lock file", "verdict.lock")
    .action(async (ref: string, o: PullOptions) => {
      const ws = workspace(deps, o);
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

/** Writes a card's public cases when it has any; shared with `verdict fork hub:…`. */
export async function writeCases(deps: HubDependencies, publication: Parameters<typeof casesJsonl>[0], path: string | undefined, force?: boolean) {
  if (!path || !publication.cases.length) return;
  await deps.writeNew(path, casesJsonl(publication), force);
  deps.out(`wrote ${path} (${publication.cases.length} public case(s)); \`verdict run -r <rubric> -d ${path}\` checks them yourself`);
}
