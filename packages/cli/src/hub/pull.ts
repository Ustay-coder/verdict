/**
 * Fetching a published card for `verdict pull` and `verdict fork hub:…` (docs/design/hub.md H4). Public reads need no
 * sign-in. The hub is not trusted to name what it sent: the rubric is frozen here and must give the version id asked for.
 */
import { formatHubRef, parseHubRef, verifyPublishedVersion, type PublicPublication, type RubricVersion } from "@verdict-ai/core";

import { hubTarget } from "./credentials.js";
import { hubClient, type HubDependencies } from "./deps.js";

export interface PulledCard { hub: string; ref: string; publication: PublicPublication; version: RubricVersion }

export async function fetchCard(deps: HubDependencies, refText: string, hubFlag?: string): Promise<PulledCard> {
  const ref = parseHubRef(refText);
  // Public reads go without a key, so a pull never sends a hub key it does not need.
  const { hub } = await hubTarget(deps.credentials, { ...deps.env, VERDICT_HUB_KEY: undefined }, hubFlag);
  const { publication } = await hubClient(deps, hub).hub.card(ref.owner, ref.slug, ref.versionId ? { version: ref.versionId } : {});
  const version = await verifyPublishedVersion(publication, ref.versionId, hub);
  return { hub, ref: formatHubRef({ owner: publication.owner, slug: publication.slug, versionId: version.id }), publication, version };
}

/** The card's public cases as a gold file (JSONL), marked public so they can be published again as they are. */
export function casesJsonl(p: PublicPublication): string {
  return p.cases.map((c) => JSON.stringify({ ...c, visibility: "public" })).join("\n") + (p.cases.length ? "\n" : "");
}

/** `--cases <file>` names the file, `--no-cases` skips it; by default cases go next to the rubric file. */
export function casesPath(rubricFile: string, option: string | boolean | undefined): string | undefined {
  if (option === false) return undefined;
  if (typeof option === "string") return option;
  return `${rubricFile.replace(/\.(ya?ml|json)$/i, "")}.cases.jsonl`;
}

/** A header line that says where a file came from and under which licence. */
export const provenanceHeader = (card: PulledCard, verb: "pulled" | "forked") =>
  `# ${verb} from ${card.ref} (${card.publication.license}) — ${card.hub}/hub/${card.publication.ref}?version=${card.version.id}\n`;
