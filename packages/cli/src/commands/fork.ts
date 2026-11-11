/**
 * Registers `verdict fork`: copy an exact version — a local `rv_…`, a rubric file, or a published `hub:owner/slug@rv_…`
 * — into a new, editable rubric file and record its parent in verdict.lock, so freezing the edited file later links the
 * two and lists what changed. A hub parent is kept locally, with where it came from and its licence.
 */
import { forkDraft, isHubRef, rubricToYaml } from "@verdict-ai/core";
import { Command } from "commander";

import { withHub, type HubDependencies } from "../hub/deps.js";
import { casesPath, fetchCard, provenanceHeader } from "../hub/pull.js";
import { updateLock, type LockEntry } from "../versions/lock.js";
import { remember, resolveVersion, versionDefaults, workspace, type VersionDependencies } from "../versions/workspace.js";
import { writeCases } from "./pull.js";

interface ForkOptions { to: string; note?: string; force?: boolean; lock?: string; hub?: string; cases?: string | boolean }

/** Registers fork; failures reach the CLI failure handler. */
export function registerFork(program: Command, deps: VersionDependencies | HubDependencies = versionDefaults) {
  program.command("fork <ref>").description("copy a rubric version (rv_…, a rubric file or hub:owner/slug@rv_…) into a new file to edit; the parent is recorded in verdict.lock")
    .requiredOption("--to <file>", "new rubric file").option("--note <text>", "why you are forking (kept with the fork)")
    .option("--hub <url>", "hub URL for hub: refs (default: VERDICT_HUB_URL or the hub you signed in to)")
    .option("--cases <file>", "hub: refs — where to write the public cases (default: next to the new file)").option("--no-cases", "hub: refs — do not write the public cases")
    .option("--force", "replace existing files").option("--lock <path>", "lock file", "verdict.lock")
    .action(async (ref: string, o: ForkOptions) => {
      const ws = workspace(deps, o);
      const card = isHubRef(ref) ? await fetchCard(withHub(deps), ref, o.hub) : undefined;
      // A hub parent must be in the local store for `version freeze` to compute what the fork changed.
      const version = card ? await remember(ws, card.version) : (await resolveVersion(ws, ref)).version;
      await deps.writeNew(o.to, `${card ? provenanceHeader(card, "forked") : `# forked from ${version.id}\n`}${rubricToYaml(forkDraft(version))}`, o.force);
      const origin: LockEntry["origin"] = card ? { hub: card.hub, ref: card.ref, license: card.publication.license } : undefined;
      await updateLock(deps.lockIo, ws.lockPath, o.to, () => ({ parent: version.id, ...(o.note ? { note: o.note } : {}), ...(origin ? { origin } : {}) }));
      deps.out(`wrote ${o.to} (fork of ${card?.ref ?? version.id}); edit it, then \`verdict version freeze ${o.to}\``);
      if (card) await writeCases(withHub(deps), card.publication, casesPath(o.to, o.cases), o.force);
    });
}
