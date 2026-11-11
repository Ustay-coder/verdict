/**
 * Registers `verdict publish` and `verdict withdraw` (docs/design/hub.md §16). Publishing sends one rubric version,
 * the cases you name (marked public here, and only those) and the numbers of the runs you name; the hub's preview is
 * shown first and is exactly what gets stored. Nothing else from your data directory leaves this machine.
 */
import { parseGoldSet, publicationRun, scoreRun, toGoldItem, ValidationError, type GoldItem, type PublicationIssue, type PublicationRequest, type PublicationResult } from "@verdict-ai/core";
import { Command } from "commander";
import { dirname, resolve } from "node:path";

import { hubTarget } from "../hub/credentials.js";
import { hubClient, hubDefaults, type HubDependencies } from "../hub/deps.js";
import { loadRun, resolveVersion, workspace, type Workspace } from "../versions/workspace.js";

interface PublishOptions {
  slug: string; license: string; cases?: string; case?: string[]; allCases?: boolean; run?: string[];
  title?: string; description?: string; domain?: string; locale?: string; source?: string[]; note?: string;
  hub?: string; dryRun?: boolean; yes?: boolean; json?: boolean; lock?: string;
}

export function registerPublish(program: Command, deps: HubDependencies = hubDefaults) {
  program.command("publish <ref>").description("publish a rubric version (file or rv_…) to the hub, with the cases and runs you name")
    .requiredOption("--slug <slug>", "name under your handle: owner/<slug>").requiredOption("--license <id>", "CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0, MIT or Apache-2.0")
    .option("--cases <file>", "gold file holding the cases to publish").option("--case <id...>", "ids of the cases to publish (they become public)").option("--all-cases", "publish every case in --cases")
    .option("--run <id...>", "stored runs of this version to attach (numbers only)")
    .option("--title <text>").option("--description <text>").option("--domain <text>").option("--locale <tag>").option("--source <url...>").option("--note <text>")
    .option("--hub <url>").option("--dry-run", "show the hub's preview and stop").option("-y, --yes", "publish without asking").option("--json").option("--lock <path>", "lock file", "verdict.lock")
    .action(async (ref: string, o: PublishOptions) => {
      const target = await hubTarget(deps.credentials, deps.env, o.hub);
      if (!target.apiKey) throw new ValidationError(`not signed in to ${target.hub}; run \`verdict hub login\``);
      const ws = workspace(deps, o);
      const request = await publicationRequest(ws, ref, o);
      const client = hubClient(deps, target.hub, target.apiKey);
      const preview = await client.publications.preview(request);
      if (o.json && (o.dryRun || !preview.ok)) deps.out(JSON.stringify(preview, null, 2));
      else for (const line of renderPreview(preview, target.hub)) deps.out(line);
      if (!preview.ok) throw new ValidationError("the hub rejected this publication; fix the issues above");
      if (o.dryRun) return;
      if (!o.yes) {
        if (!deps.interactive()) throw new ValidationError("pass --yes to publish without a terminal (the preview above is what would be published)");
        if (!(await deps.confirm(`Publish ${preview.publication!.ref} at ${preview.publication!.version.id}?`))) { deps.out("not published"); return; }
      }
      const { publication, created } = await client.publications.create(request);
      if (o.json) { deps.out(JSON.stringify(publication, null, 2)); return; }
      deps.out(created ? `published ${publication.ref} at ${publication.version.id} (${publication.id})` : `already published: ${publication.ref} at ${publication.version.id} (${publication.id})`);
    });

  program.command("withdraw <publicationId>").description("withdraw one of your publications from the hub (copies already taken are not recalled)").option("--hub <url>")
    .action(async (id: string, o: { hub?: string }) => {
      const target = await hubTarget(deps.credentials, deps.env, o.hub);
      if (!target.apiKey) throw new ValidationError(`not signed in to ${target.hub}; run \`verdict hub login\``);
      await hubClient(deps, target.hub, target.apiKey).publications.withdraw(id);
      deps.out(`withdrew ${id}`);
    });
}

async function publicationRequest(ws: Workspace, ref: string, o: PublishOptions): Promise<PublicationRequest> {
  const { version } = await resolveVersion(ws, ref);
  const cases = await chosenCases(ws, o);
  // A stored run and its agreement report name every case; only numbers, and the ids of cases published here, are sent.
  const published = cases.flatMap((c) => (c.id ? [c.id] : []));
  const runs = await Promise.all((o.run ?? []).map(async (id) => {
    const { run, version: runVersion, evaluations } = await loadRun(ws, id);
    const dataset = await ws.store.getDatasetVersion(run.datasetVersionId);
    if (!dataset) throw new ValidationError(`run ${id}'s dataset ${run.datasetVersionId} is missing`);
    return publicationRun(run, scoreRun(runVersion, dataset, evaluations), published);
  }));
  return {
    slug: o.slug, license: o.license,
    version: { id: version.id, rubric: version.rubric, ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}), ...(version.fork ? { fork: version.fork } : {}) },
    cases, runs,
    ...pick({ title: o.title, description: o.description, domain: o.domain, locale: o.locale, note: o.note }),
    ...(o.source?.length ? { sources: o.source } : {}),
  };
}

/** Only cases named with --case (or all with --all-cases) are sent, and only those are marked public. */
async function chosenCases(ws: Workspace, o: PublishOptions): Promise<GoldItem[]> {
  if (!o.cases) {
    if (o.case?.length || o.allCases) throw new ValidationError("--case and --all-cases need --cases <gold file>");
    return [];
  }
  if (!o.case?.length && !o.allCases) throw new ValidationError("name the cases to publish with --case <id...>, or pass --all-cases");
  const path = resolve(o.cases);
  const all = parseGoldSet(await ws.deps.readText(path), dirname(path));
  const chosen = o.allCases ? all : all.filter((c) => o.case!.includes(c.id));
  const missing = (o.case ?? []).filter((id) => !all.some((c) => c.id === id));
  if (missing.length) throw new ValidationError(`no case ${missing.join(", ")} in ${o.cases}`);
  return chosen.map((c) => ({ ...toGoldItem(c), visibility: "public" as const }));
}

function renderPreview(p: PublicationResult, hub: string): string[] {
  const lines: string[] = [];
  const issue = (i: PublicationIssue) => `  ${i.path}: ${i.message}`;
  if (!p.ok) return [`${hub} would not publish this:`, ...p.issues.map(issue)];
  const pub = p.publication!;
  lines.push(`preview on ${hub} — this is exactly what would be public:`);
  lines.push(`  ${pub.ref} at ${pub.version.id} · ${pub.title} · ${pub.judgmentType} · ${pub.license}`);
  if (pub.parent) lines.push(`  forked from ${pub.parent.public ? `${pub.parent.ref} (${pub.parent.versionId})` : "a version that is not public"}${pub.version.changeKinds ? `: ${pub.version.changeKinds.join(", ")}` : ""}`);
  lines.push(`  cases: ${pub.cases.length}${pub.cases.length ? ` (${pub.cases.map((c) => c.id).join(", ")})` : ""}`);
  for (const r of pub.runs) lines.push(`  run ${r.runId}: ${r.counts.cases} cases, ${r.casesPublic ? "all public — anyone can repeat it" : "includes private cases — numbers only"}`);
  if (p.warnings.length) lines.push("warnings:", ...p.warnings.map(issue));
  return lines;
}

function pick<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}
